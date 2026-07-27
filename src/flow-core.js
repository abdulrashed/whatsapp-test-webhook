import {
  fetchVenueDetails,
  fetchCourtDetails,
  getAvailableStartTimes,
  isBookingSlotAvailable,
  priceForSpan,
  waIdToUserId
} from "./booking.js";
import { logInfo, logWarn } from "./logger.js";

// Business logic for the WhatsApp Flow endpoint (book-slot). Given a decrypted
// request from Meta it returns the next screen + its data. Kept separate from
// api/flow.js (crypto/HTTP) so it can be unit-tested without encryption.
//
// The Flow runs in data_exchange mode: WhatsApp calls INIT to get the first
// screen, then each screen's Footer posts a data_exchange with the running
// selection accumulated in its payload, so the endpoint stays stateless per
// request. flow_token carries venue + user identity: "v1|<venueId>|<waId>".

const MAX_DURATION_HOURS = 8;

// Meta caps a ChipsSelector at 20 options, and Flow JSON cannot repeat a
// component over an array — so DATE declares a fixed number of chip groups and
// hides the unused ones. Chips are grouped by calendar month and each month is
// chunked at 20, so a month costs at most 2 groups. A window of <= 31 days
// touches at most 2 months, which fits the 4 declared groups; longer windows
// are clamped rather than silently dropping dates.
const CHIPS_PER_GROUP = 20;
const DATE_CHIP_GROUPS = 4;
const MAX_BOOKING_DAYS = 31;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildFlowToken(venueId, waId) {
  return `v1|${venueId}|${waId}`;
}

function parseFlowToken(token) {
  const [, venueId, waId] = String(token || "").split("|");
  return { venueId: venueId || null, waId: waId || null };
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// ChipsSelector is multi-select by nature, so ${form.<name>} arrives as an
// array even with max-selected-items: 1. Deselecting a chip fires the same
// on-select-action with an empty array, which callers treat as "no choice yet".
function firstOf(value) {
  if (Array.isArray(value)) return value.length ? value[0] : null;
  if (value === "" || value == null) return null;
  return value;
}

// DATE chips submit "YYYY-MM-DD" directly. The older DatePicker submitted
// epoch-millis (string) — still accepted so an in-flight Flow version keeps
// working after a redeploy.
function normalizeDate(value) {
  const raw = firstOf(value);
  if (raw == null) return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Number(s);
  if (!Number.isNaN(ms)) return dateStr(new Date(ms));
  return null;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ---- Screen builders --------------------------------------------------------

// Every selection screen renders as ChipsSelector. Chips can't carry an
// on-select-action, so each screen pairs its chips with a "Next" Footer that
// submits the form value(s). Meta caps a ChipsSelector at CHIPS_PER_GROUP
// options, so long lists (dates, time slots) are split across labelled groups.
async function sportScreen(venueId) {
  const courts = await fetchCourtDetails(venueId);
  const seen = new Map();
  for (const c of courts) {
    for (const s of c.sports || []) {
      const name = s.sport_name || s.name;
      if (name && !seen.has(name)) seen.set(name, { id: name, title: name });
    }
  }
  const sports = [...seen.values()];
  if (!sports.length) return infoScreen("This venue has no sports configured yet.");
  return { screen: "SPORT", data: { sports: sports.slice(0, CHIPS_PER_GROUP) } };
}

// Builds the open days as chip groups: one group per calendar month, split
// again whenever a month exceeds CHIPS_PER_GROUP. Only the first chunk of a
// month carries the month heading so a split month still reads as one block.
function buildDateChipGroups(daysCount) {
  const span = Math.min(Math.max(Number(daysCount) || 30, 1), MAX_BOOKING_DAYS);
  const byMonth = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  for (let i = 0; i < span; i++) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}`;
    if (!byMonth.length || byMonth[byMonth.length - 1].key !== key) {
      byMonth.push({
        key,
        label: `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        days: []
      });
    }
    byMonth[byMonth.length - 1].days.push({
      id: dateStr(cursor),
      title: `${cursor.getDate()} ${WEEKDAY_NAMES[cursor.getDay()]}`
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const groups = [];
  for (const month of byMonth) {
    for (let i = 0; i < month.days.length; i += CHIPS_PER_GROUP) {
      groups.push({
        // Continuation chunks repeat no heading; the chips read as one month.
        label: i === 0 ? month.label : " ",
        days: month.days.slice(i, i + CHIPS_PER_GROUP)
      });
    }
  }
  return groups.slice(0, DATE_CHIP_GROUPS);
}

async function dateScreen(venueId, acc) {
  const venue = await fetchVenueDetails(venueId);
  const groups = buildDateChipGroups(venue?.days_count);
  if (!groups.length) return infoScreen("This venue isn't open for booking right now.");

  const data = { sport_name: acc.sport_name };
  for (let i = 0; i < DATE_CHIP_GROUPS; i++) {
    const group = groups[i];
    const n = i + 1;
    data[`g${n}_label`] = group?.label || " ";
    data[`g${n}_days`] = group?.days || [];
    // g1 is always rendered; the rest are hidden when unused.
    if (n > 1) data[`g${n}_visible`] = Boolean(group);
  }
  return { screen: "DATE", data };
}

async function courtOrTimeScreen(venueId, acc) {
  const courts = await fetchCourtDetails(venueId);
  const active = courts.filter((c) => c.status !== "inactive");
  if (active.length <= 1) {
    const court = active[0] || courts[0];
    if (!court) return infoScreen("No courts available at this venue.");
    return timeScreen(venueId, { ...acc, court_id: court.id, court_name: court.name });
  }
  return {
    screen: "COURT",
    data: {
      courts: active.slice(0, CHIPS_PER_GROUP).map((c) => ({ id: c.id, title: c.name })),
      sport_name: acc.sport_name,
      date: acc.date
    }
  };
}

async function timeScreen(venueId, acc) {
  const courts = await fetchCourtDetails(venueId);
  const court = courts.find((c) => c.id === acc.court_id) || null;
  const courtName = acc.court_name || court?.name || "Court";

  const waId = acc.__waId;
  const times = await getAvailableStartTimes(acc.court_id, acc.date, {
    excludeUserId: waId ? waIdToUserId(waId) : undefined
  });
  if (!times.length) {
    return infoScreen("Sorry, no free slots for that date. Please try another date.");
  }
  // A day can hold more slots than one ChipsSelector allows, so split at noon —
  // which also reads better than one long strip.
  const chip = (t) => ({ id: t.slot_time, title: to12h(t.slot_time) });
  const am = times.filter((t) => Number(t.slot_time.split(":")[0]) < 12);
  const pm = times.filter((t) => Number(t.slot_time.split(":")[0]) >= 12);

  return {
    screen: "TIME",
    data: {
      times_am: am.slice(0, CHIPS_PER_GROUP).map(chip),
      times_pm: pm.slice(0, CHIPS_PER_GROUP).map(chip),
      am_visible: am.length > 0,
      pm_visible: pm.length > 0,
      sport_name: acc.sport_name,
      date: acc.date,
      court_id: acc.court_id,
      court_name: courtName
    }
  };
}

// Offer only durations whose whole span is still free (re-checked live).
async function durationScreen(acc) {
  const durations = [];
  for (let h = 1; h <= MAX_DURATION_HOURS; h++) {
    const end = addMinutes(acc.start_time, h * 60);
    // eslint-disable-next-line no-await-in-loop
    const ok = await isBookingSlotAvailable(acc.date, acc.court_id, acc.start_time, end);
    if (!ok) break; // once an hour is blocked, longer spans are too
    // eslint-disable-next-line no-await-in-loop
    const { price } = await priceForSpan(acc.court_id, acc.date, acc.start_time, end);
    // Kept short so the chips stay compact; the full span is on SUMMARY.
    durations.push({ id: String(h), title: `${h}h · ₹${price}` });
  }
  if (!durations.length) {
    return infoScreen("That start time is no longer available. Please try another.");
  }
  return {
    screen: "DURATION",
    data: {
      durations,
      sport_name: acc.sport_name,
      date: acc.date,
      court_id: acc.court_id,
      court_name: acc.court_name,
      start_time: acc.start_time
    }
  };
}

async function summaryScreen(venue, acc) {
  const hours = Number(acc.duration);
  const end = addMinutes(acc.start_time, hours * 60);
  const { price, advance } = await priceForSpan(acc.court_id, acc.date, acc.start_time, end);
  const payType = venue?.payment_type === "advance" ? "advance" : "full";
  const payAmount = payType === "advance" ? advance : price;

  const summary =
    `📋 *Booking summary*\n\n` +
    `🏟️ ${acc.court_name}\n` +
    `🎾 ${acc.sport_name}\n` +
    `📅 ${acc.date}\n` +
    `⏰ ${to12h(acc.start_time)} – ${to12h(end)} (${hours}h)\n` +
    `💰 Total ₹${price}` +
    (payType === "advance" ? `\n💳 Pay now (advance) ₹${payAmount}` : "");

  return {
    screen: "SUMMARY",
    data: {
      summary_text: summary,
      sport_name: acc.sport_name,
      date: acc.date,
      court_id: acc.court_id,
      court_name: acc.court_name,
      start_time: acc.start_time,
      end_time: end,
      price: String(price),
      advance: String(advance),
      pay_amount: String(payAmount)
    }
  };
}

function infoScreen(message) {
  return { screen: "INFO", data: { info_text: message } };
}

function to12h(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// ---- Router -----------------------------------------------------------------

export async function handleFlowRequest(body) {
  const { action, screen, data, flow_token } = body || {};

  // Health check from Meta's Flow Builder / periodic pings.
  if (action === "ping") {
    return { data: { status: "active" } };
  }

  // A client-side error report — just acknowledge.
  if (data?.error) {
    logWarn("Flow client error reported", { error: data.error });
    return { data: { acknowledged: true } };
  }

  const { venueId, waId } = parseFlowToken(flow_token);
  if (!venueId) {
    logWarn("Flow request missing venueId in flow_token", { flow_token });
    return infoScreen("Something went wrong starting your booking. Please try again.");
  }

  const acc = { ...(data || {}), __waId: waId };

  if (action === "INIT") {
    return sportScreen(venueId);
  }

  if (action === "data_exchange") {
    switch (screen) {
      case "SPORT": {
        const sportName = firstOf(acc.sport_name);
        if (!sportName) return sportScreen(venueId);
        return dateScreen(venueId, { ...acc, sport_name: sportName });
      }
      case "DATE": {
        // ChipsSelector has no on-select-action, so DATE uses a Footer that
        // submits all group fields; the chosen day is in whichever is non-empty.
        // No selection (footer tapped early) → redraw DATE.
        const raw = firstOf(acc.date_g1) || firstOf(acc.date_g2)
          || firstOf(acc.date_g3) || firstOf(acc.date_g4);
        const date = normalizeDate(raw);
        if (!date) return dateScreen(venueId, acc);
        return courtOrTimeScreen(venueId, { ...acc, date });
      }
      case "COURT": {
        const courtId = firstOf(acc.court_id);
        if (!courtId) return courtOrTimeScreen(venueId, acc);
        return timeScreen(venueId, { ...acc, court_id: courtId });
      }
      case "TIME": {
        // Slots are split across a morning and an afternoon/evening chip group.
        const startTime = firstOf(acc.start_time_am) || firstOf(acc.start_time_pm);
        if (!startTime) return timeScreen(venueId, acc);
        return durationScreen({ ...acc, start_time: startTime });
      }
      case "DURATION": {
        const duration = firstOf(acc.duration);
        if (!duration) return durationScreen(acc);
        return summaryScreen(await fetchVenueDetails(venueId), { ...acc, duration });
      }
      default:
        logWarn("Unknown Flow screen in data_exchange", { screen });
        return infoScreen("Something went wrong. Please try again.");
    }
  }

  logInfo("Unhandled Flow action", { action });
  return infoScreen("Something went wrong. Please try again.");
}
