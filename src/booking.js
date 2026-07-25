import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";

import { db } from "./firebase.js";
import { logError, logWarn } from "./logger.js";

// Data layer for the WhatsApp booking flow. Ported from the GameOn Turf-App
// firebase modules (booking.js, blockConcurrent.js, weeklySlots.js,
// dailySlots.js, courtDetails.js, venueDetails.js) so the same Firestore
// (turf-app-930c5) drives both surfaces. Deliberately excluded from the port:
// the app's finance auto-sync and coupon redemption. Those only fire for
// payments with status "success"; the WhatsApp path always creates a
// "processing" booking (payment status "processing") and the authoritative
// Razorpay webhook (v2_webhook_live.php) handles finance + coupons on capture.

const HOLD_DURATION_MS = 5 * 60 * 1000; // matches FEATURES.SLOT_HOLD_DURATION_MINUTES

// "HH:mm" -> minutes since midnight; "24:00" is end-of-day (1440).
function toMinutes(t) {
  if (t === "24:00") return 1440;
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}

// Midnight typed as an END means end-of-day; store as "24:00" so the
// start < end invariant holds for same-day records (matches the app).
function normalizeEndTime(t) {
  return t === "00:00" ? "24:00" : t;
}

function dayNameFor(dateStr) {
  const raw = new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long"
  });
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function nextDateStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Venue + courts
// ---------------------------------------------------------------------------

export async function fetchVenueDetails(venueId) {
  try {
    const snap = await getDoc(doc(db, "venue_details", venueId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    logError("fetchVenueDetails failed", { venueId, error: error?.message });
    return null;
  }
}

export async function fetchCourtDetails(venueId) {
  try {
    const q = query(
      collection(db, "courts_details"),
      where("venue_id", "==", venueId),
      orderBy("sequence", "asc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    logError("fetchCourtDetails failed", { venueId, error: error?.message });
    return [];
  }
}

// Distinct sports offered across a venue's courts, deduped by name.
export function sportsForCourts(courts) {
  const seen = new Map();
  for (const court of courts || []) {
    for (const s of court.sports || []) {
      const name = s.sport_name || s.name;
      if (name && !seen.has(name)) {
        seen.set(name, { name, img: s.img_url || s.img || "" });
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Slot template (daily override, else weekly recurring)
// ---------------------------------------------------------------------------

async function fetchDailySlots(courtId, dateStr) {
  try {
    const q = query(
      collection(db, "daily_slots"),
      where("court_id", "==", courtId),
      where("date", "==", dateStr)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    logError("fetchDailySlots failed", { courtId, dateStr, error: error?.message });
    return [];
  }
}

async function fetchWeeklyByDay(courtId, dayName) {
  try {
    const q = query(
      collection(db, "weekly_slots"),
      where("court_id", "==", courtId),
      where("days", "==", dayName)
    );
    const snap = await getDocs(q);
    return snap.docs[0] ? snap.docs[0].data() : null;
  } catch (error) {
    logError("fetchWeeklyByDay failed", { courtId, dayName, error: error?.message });
    return null;
  }
}

// Resolves the effective slot template for a court on a date: a daily_slots
// override wins, otherwise the weekly recurring template for that weekday.
// Returns { isDayActive, slots:[{ slot_time, price, advance, status }] }.
async function resolveSlotTemplate(courtId, dateStr) {
  const daily = await fetchDailySlots(courtId, dateStr);
  if (daily.length) {
    return { isDayActive: daily[0].is_day_active !== false, slots: daily[0].slots || [] };
  }
  const weekly = await fetchWeeklyByDay(courtId, dayNameFor(dateStr));
  if (weekly) {
    return { isDayActive: weekly.is_day_active !== false, slots: weekly.slots || [] };
  }
  return { isDayActive: false, slots: [] };
}

// ---------------------------------------------------------------------------
// Bookings + concurrency holds (ported)
// ---------------------------------------------------------------------------

export async function fetchBookingsByDateAndCourt(date, courtId) {
  const q = query(
    collection(db, "bookings"),
    where("court_id", "==", courtId),
    where("date", "==", date),
    where("booking_type", "in", ["blocked", "offline", "online"])
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Verbatim overlap logic from the app, including cross-midnight handling.
export async function isBookingSlotAvailable(date, courtId, selectedStart, selectedEnd) {
  const bookings = await fetchBookingsByDateAndCourt(date, courtId);

  const selStart = toMinutes(selectedStart);
  const selEnd = toMinutes(selectedEnd);

  const isCrossDate =
    selEnd < selStart && selectedEnd !== "00:00" && selectedEnd !== "24:00";

  if (selStart === selEnd) return true;

  for (const b of bookings) {
    if (!["online", "offline", "blocked"].includes(b.booking_type)) continue;
    if (b.status === "cancelled") continue;

    const bStart = toMinutes(b.start_time);
    const bEnd = toMinutes(b.end_time);
    const bIsCrossDate = b.is_cross_date && !b.is_dummy;

    const effectiveBEnd = bIsCrossDate ? 1440 : bEnd;
    const effectiveSelEnd = isCrossDate ? 1440 : selEnd;

    const isTouchingBoundary = selStart === effectiveBEnd || effectiveSelEnd === bStart;
    const isOverlap =
      selStart < effectiveBEnd && effectiveSelEnd > bStart && !isTouchingBoundary;

    if (isOverlap) return false;
  }

  if (isCrossDate) {
    const nextDay = await fetchBookingsByDateAndCourt(nextDateStr(date), courtId);
    for (const b of nextDay) {
      if (b.booking_type !== "online" && b.booking_type !== "blocked") continue;
      if (b.status === "cancelled") continue;

      const bStart = toMinutes(b.start_time);
      const bEnd = toMinutes(b.end_time);
      const isTouchingBoundary = bEnd === 0 || selEnd === bStart;
      const isOverlap = bEnd > 0 && selEnd > bStart && !isTouchingBoundary;
      if (isOverlap) return false;
    }
  }

  return true;
}

export async function addToBlockConcurrentBookings(startTime, endTime, userId, date, courtId) {
  try {
    const ref = await addDoc(collection(db, "block_concurrent"), {
      startTime,
      endTime,
      userId,
      date,
      courtId,
      createdAt: serverTimestamp()
    });
    return ref.id;
  } catch (error) {
    logError("addToBlockConcurrentBookings failed", { courtId, date, error: error?.message });
    return null;
  }
}

export async function deleteUserBlockForCourt(userId, courtId, date) {
  if (!userId || !courtId || !date) return false;
  try {
    const q = query(
      collection(db, "block_concurrent"),
      where("userId", "==", userId),
      where("courtId", "==", courtId),
      where("date", "==", date)
    );
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      await deleteDoc(doc(db, "block_concurrent", d.id));
    }
    return true;
  } catch (error) {
    logError("deleteUserBlockForCourt failed", { userId, courtId, date, error: error?.message });
    return false;
  }
}

// Active (unexpired) holds by another user overlapping [startTime, endTime).
// A user's own hold never blocks them.
async function activeBlockRanges(courtId, date, excludeUserId) {
  try {
    const q = query(
      collection(db, "block_concurrent"),
      where("courtId", "==", courtId),
      where("date", "==", date)
    );
    const snap = await getDocs(q);
    const now = Date.now();
    const ranges = [];
    snap.forEach((d) => {
      const data = d.data();
      if (excludeUserId && data.userId === excludeUserId) return;
      const created =
        data.createdAt && typeof data.createdAt.toDate === "function"
          ? data.createdAt.toDate().getTime()
          : null;
      // A hold with no server timestamp yet (just written) is treated as active.
      if (created !== null && now - created > HOLD_DURATION_MS) return;
      if (typeof data.startTime === "string" && typeof data.endTime === "string") {
        ranges.push([toMinutes(data.startTime), toMinutes(data.endTime)]);
      }
    });
    return ranges;
  } catch (error) {
    logWarn("activeBlockRanges failed, ignoring holds", { courtId, date, error: error?.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Availability for the Flow's TIME screen
// ---------------------------------------------------------------------------

// Returns bookable one-hour start times for a court on a date, each with its
// price/advance, excluding inactive slots, existing bookings, and live holds.
// Shape: [{ slot_time, price, advance }]
export async function getAvailableStartTimes(courtId, date, { excludeUserId } = {}) {
  const { isDayActive, slots } = await resolveSlotTemplate(courtId, date);
  if (!isDayActive || !slots.length) return [];

  const bookings = await fetchBookingsByDateAndCourt(date, courtId);
  const bookedRanges = bookings
    .filter((b) => b.status !== "cancelled")
    .map((b) => [toMinutes(b.start_time), b.is_cross_date && !b.is_dummy ? 1440 : toMinutes(b.end_time)]);
  const holdRanges = await activeBlockRanges(courtId, date, excludeUserId);
  const blocked = [...bookedRanges, ...holdRanges];

  const overlapsBlocked = (start, end) =>
    blocked.some(([bs, be]) => start < be && end > bs);

  const today = new Date();
  const isToday = date === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const nowMin = today.getHours() * 60 + today.getMinutes();

  return slots
    .filter((s) => s.status === "active")
    .map((s) => ({ slot_time: s.slot_time, price: s.price, advance: s.advance, start: toMinutes(s.slot_time) }))
    .filter((s) => !(isToday && s.start <= nowMin)) // hide past hours for today
    .filter((s) => !overlapsBlocked(s.start, s.start + 60)) // first hour must be free
    .sort((a, b) => a.start - b.start)
    .map(({ slot_time, price, advance }) => ({ slot_time, price, advance }));
}

// Total price/advance for a [startTime, endTime) span by summing the hourly
// slot prices it covers. endTime "00:00"/"24:00" means end-of-day.
export async function priceForSpan(courtId, date, startTime, endTime) {
  const { slots } = await resolveSlotTemplate(courtId, date);
  const start = toMinutes(startTime);
  let end = toMinutes(endTime);
  if (end <= start) end += 1440; // cross-midnight span

  let price = 0;
  let advance = 0;
  for (const s of slots) {
    if (s.status !== "active") continue;
    const t = toMinutes(s.slot_time);
    // Each hourly slot covers [t, t+60); count it if its start falls in the span.
    const tWrapped = t < start ? t + 1440 : t;
    if (tWrapped >= start && tWrapped < end) {
      price += Number(s.price) || 0;
      advance += Number(s.advance) || 0;
    }
  }
  return { price, advance };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// The WhatsApp wa_id is E.164 digits (e.g. 919876543210). GameOn user docs are
// keyed by the bare 10-digit local number, so strip a leading country code.
export function waIdToUserId(waId) {
  const digits = String(waId).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export async function fetchUserById(userId) {
  try {
    const snap = await getDoc(doc(db, "users", String(userId)));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    logError("fetchUserById failed", { userId, error: error?.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create the provisional ("processing") booking + order id
// ---------------------------------------------------------------------------

// Simplified port of bookSlotTransaction for the WhatsApp path: always
// bookingType "processing", payment status "processing", no finance/coupon
// side effects (the Razorpay webhook owns those on capture). Handles the
// cross-midnight case with the same main+dummy booking pair the app uses so
// slot-overlap checks stay correct across the two surfaces.
export async function createProcessingBooking({
  venue,
  court,
  user,
  sport,
  date,
  startTime,
  endTime,
  slotCost,
  finalAmount,
  paidAmount
}) {
  const base = {
    booking_type: "processing",
    type: "single",
    status: "active",
    venue_id: venue.id,
    venue_name: venue.name,
    venue_contact: venue.contact_number || "",
    venue_logo: venue.logo_url || venue.venue_img?.[0] || "",
    court_id: court.id,
    court_name: court.name,
    sport: { name: sport.name, img: sport.img || "" },
    date,
    start_time: startTime,
    slot_cost: slotCost,
    final_amount: finalAmount,
    paid_amount: paidAmount,
    user: {
      country_code: "+91",
      name: user.name || "",
      phone: user.phone || "",
      profile_img_url: user.profile_img_url || ""
    },
    user_id: user.id,
    payment: [
      {
        amount: paidAmount,
        method: "Razorpay",
        paid_user_id: user.id,
        payment_datetime: Timestamp.fromDate(new Date()),
        status: "processing",
        transaction_ref: ""
      }
    ],
    created_datetime: Timestamp.fromDate(new Date()),
    updated_datetime: Timestamp.fromDate(new Date())
  };

  const isCrossDate = endTime !== "00:00" && toMinutes(endTime) < toMinutes(startTime);

  if (isCrossDate) {
    const batch = writeBatch(db);
    const mainRef = doc(collection(db, "bookings"));
    const dummyRef = doc(collection(db, "bookings"));

    const mainPayload = {
      ...base,
      end_time: endTime,
      is_cross_date: true,
      linked_booking_id: dummyRef.id
    };
    const dummyPayload = {
      ...base,
      date: nextDateStr(date),
      start_time: "00:00",
      end_time: normalizeEndTime(endTime),
      is_cross_date: true,
      is_dummy: true,
      linked_booking_id: mainRef.id,
      booking_type: "blocked",
      slot_cost: 0,
      final_amount: 0,
      paid_amount: 0,
      payment: []
    };

    batch.set(mainRef, mainPayload);
    batch.set(dummyRef, dummyPayload);
    await batch.commit();
    return { id: mainRef.id, ...mainPayload };
  }

  const payload = { ...base, end_time: normalizeEndTime(endTime) };
  const ref = await addDoc(collection(db, "bookings"), payload);
  return { id: ref.id, ...payload };
}

export async function updateBookingOrderId(bookingId, orderId) {
  const ref = doc(db, "bookings", bookingId);
  await updateDoc(ref, {
    order_id: orderId,
    updated_datetime: Timestamp.fromDate(new Date())
  });
  const snap = await getDoc(ref);
  return { id: snap.id, ...snap.data() };
}

// ---------------------------------------------------------------------------
// My Bookings
// ---------------------------------------------------------------------------

// Upcoming confirmed bookings for a WhatsApp user, newest first, hiding the
// cross-date dummy records. Uses waIdToUserId to match the users doc key.
export async function fetchUpcomingBookings(waId, max = 10) {
  const userId = waIdToUserId(waId);
  try {
    const q = query(
      collection(db, "bookings"),
      where("user_id", "==", userId),
      orderBy("date", "desc"),
      limit(max * 2)
    );
    const snap = await getDocs(q);
    const todayStr = new Date().toISOString().slice(0, 10);
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => !b.is_dummy)
      .filter((b) => b.booking_type === "online" && b.status !== "cancelled")
      .filter((b) => b.date >= todayStr)
      .slice(0, max);
  } catch (error) {
    logError("fetchUpcomingBookings failed", { waId, error: error?.message });
    return [];
  }
}
