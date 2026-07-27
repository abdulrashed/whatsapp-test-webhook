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

// SPORT renders its options as a ChipsSelector, which Meta will only draw with
// 2 to 20 options — fewer and it reports "dataSource array must contain at
// least 2 options", more and it draws nothing at all.
const MIN_CHIPS = 2;
const MAX_CHIPS = 20;

// DATE lays the booking window out as chips over two groups at most, so the
// window is clamped to what those can hold.
const MAX_BOOKING_DAYS = MAX_CHIPS * 2;

// A group hidden by `visible: false` still has to hold MIN_CHIPS — an empty
// data-source leaves the screen's form invalid, and an invalid form blocks the
// footer. Filler that never renders and never matches a real date.
const UNUSED_CHIPS = [
  { id: "__unused_1", title: "—" },
  { id: "__unused_2", title: "—" }
];

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

// A ChipsSelector is multi-select by nature, so ${form.sport} arrives as an
// array even under max-selected-items: 1. Every other screen submits a plain
// string, which passes through untouched.
function firstOf(value) {
  if (Array.isArray(value)) return value.length ? value[0] : null;
  if (value === "" || value == null) return null;
  return value;
}

// Date chips submit "YYYY-MM-DD" directly. The DatePicker this replaced
// submitted epoch-millis — still accepted so a Flow published before the
// redeploy keeps working.
function normalizeDate(value) {
  if (value == null) return null;
  const s = String(value);
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
  // One sport is not a choice, and chips will not render it — open on the date.
  if (sports.length < MIN_CHIPS) {
    return dateScreen(venueId, { sport_name: sports[0].id });
  }
  return { screen: "SPORT", data: { sports: sports.slice(0, MAX_CHIPS) } };
}

// The venue's booking window as chips: today plus days_count - 1, in one group
// where it fits and two even halves where it does not. Two is enough for the
// 40-day clamp, and an even split never leaves a chunk below MIN_CHIPS the way
// "20 then the remainder" would.
function buildDateChipGroups(daysCount) {
  const wanted = Math.max(Number(daysCount) || 30, 1);
  const span = Math.min(wanted, MAX_BOOKING_DAYS);
  if (wanted > span) {
    logWarn("Booking window clamped to fit the date chips", { wanted, shown: span });
  }
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  const days = [];
  for (let i = 0; i < span; i++) {
    days.push({
      id: dateStr(cursor),
      day: cursor.getDate(),
      month: cursor.getMonth(),
      weekday: WEEKDAY_NAMES[cursor.getDay()]
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const size = days.length > MAX_CHIPS ? Math.ceil(days.length / 2) : days.length;
  const groups = [];
  for (let i = 0; i < days.length; i += size) groups.push(days.slice(i, i + size));
  return groups.map((group) => {
    const home = group[0].month;
    return {
      label: labelFor(group),
      // The label names the group's own month, so only days carried over from
      // the next one have to say which month they belong to.
      days: group.map((d) => ({
        id: d.id,
        title: d.month === home ? `${d.weekday} ${d.day}` : `${d.weekday} ${d.day} ${MONTH_ABBR[d.month]}`
      }))
    };
  });
}

// "July" for a group inside one month, "July 28 – August 11" for one that
// crosses into the next. Never empty: `label` is mandatory on a ChipsSelector
// and a blank one invalidates the whole screen's form.
function labelFor(days) {
  const first = days[0];
  const last = days[days.length - 1];
  if (first.month === last.month) return MONTH_NAMES[first.month];
  return `${MONTH_NAMES[first.month]} ${first.day} – ${MONTH_NAMES[last.month]} ${last.day}`;
}

async function dateScreen(venueId, acc) {
  const venue = await fetchVenueDetails(venueId);
  const [g1, g2] = buildDateChipGroups(venue?.days_count);
  if (!g1) return infoScreen("This venue isn't open for booking right now.");
  // A one-day window is not a choice, and chips will not draw a lone option.
  if (!g2 && g1.days.length < MIN_CHIPS) {
    return courtOrTimeScreen(venueId, { ...acc, date: g1.days[0].id });
  }

  return {
    screen: "DATE",
    data: {
      g1_label: g1.label,
      g1_days: g1.days,
      // Only one group can be required. Requiring g1 while g2 is on screen
      // would leave the footer disabled for anyone picking a later date, so a
      // split window relies on the endpoint guard instead — at the cost of an
      // "(Optional)" beside both labels.
      g1_required: !g2,
      g2_label: g2?.label || "Later",
      g2_days: g2?.days || UNUSED_CHIPS,
      // A hidden group still has to satisfy the 2-chip rule: an invalid
      // component anywhere on the screen blocks the footer, visible or not.
      g2_visible: Boolean(g2),
      sport_name: acc.sport_name
    }
  };
}

async function courtOrTimeScreen(venueId, acc) {
  const courts = await fetchCourtDetails(venueId);
  const active = courts.filter((c) => c.status !== "inactive");
  // A lone court is not a choice, and chips need MIN_CHIPS to render at all.
  if (active.length < MIN_CHIPS) {
    const court = active[0] || courts[0];
    if (!court) return infoScreen("No courts available at this venue.");
    return timeScreen(venueId, { ...acc, court_id: court.id, court_name: court.name });
  }
  return {
    screen: "COURT",
    data: {
      courts: active.slice(0, MAX_CHIPS).map((c) => ({ id: c.id, title: c.name })),
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
  // The only free slot is not a choice, and chips will not render it alone.
  if (times.length < MIN_CHIPS) {
    return durationScreen(venueId, { ...acc, court_name: courtName, start_time: times[0].slot_time });
  }
  // Slots are hourly, so a day holds at most 24 and all but a round-the-clock
  // venue fits. Truncating loses bookable hours, so say so in the logs.
  if (times.length > MAX_CHIPS) {
    logWarn("Start times truncated to fit a ChipsSelector", {
      courtId: acc.court_id,
      date: acc.date,
      available: times.length,
      shown: MAX_CHIPS
    });
  }
  return {
    screen: "TIME",
    data: {
      times: times.slice(0, MAX_CHIPS).map((t) => ({ id: t.slot_time, title: to12hShort(t.slot_time) })),
      sport_name: acc.sport_name,
      date: acc.date,
      court_id: acc.court_id,
      court_name: courtName
    }
  };
}

// Offer only durations whose whole span is still free (re-checked live).
//
// Rendered as chips, one per row. Flow JSON has no chips-per-row setting — a
// ChipsSelector wraps to fill the width — so the row break comes from the label
// itself: "2 hours · till 8 AM · ₹600" is wide enough that a second chip cannot
// fit beside it. Keep the end time and price in the title for that reason as
// much as for what they say; shortening it packs two to a row again.
async function durationScreen(venueId, acc) {
  const durations = [];
  for (let h = 1; h <= MAX_DURATION_HOURS; h++) {
    const end = addMinutes(acc.start_time, h * 60);
    // eslint-disable-next-line no-await-in-loop
    const ok = await isBookingSlotAvailable(acc.date, acc.court_id, acc.start_time, end);
    if (!ok) break; // once an hour is blocked, longer spans are too
    // eslint-disable-next-line no-await-in-loop
    const { price } = await priceForSpan(acc.court_id, acc.date, acc.start_time, end);
    durations.push({
      id: String(h),
      title: `${h} hour${h > 1 ? "s" : ""} · till ${to12hShort(end)} · ₹${price}`
    });
  }
  if (!durations.length) {
    return infoScreen("That start time is no longer available. Please try another.");
  }
  // Only one length fits before the next booking — chips will not draw a lone
  // option, and it is no choice anyway. The summary still shows it before
  // anyone pays.
  if (durations.length < MIN_CHIPS) {
    const venue = await fetchVenueDetails(venueId);
    return summaryScreen(venue, { ...acc, duration: durations[0].id });
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

// Same clock, minus a ":00" that buys nothing on a chip: "8 AM", "8:30 AM".
function to12hShort(hhmm) {
  return to12h(hhmm).replace(":00", "");
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
    // The exact payload Meta built from the screen's Footer action — the one
    // thing that tells a missing selection apart from a stale published Flow.
    logInfo("Flow data_exchange", { screen, payload: data || null });

    switch (screen) {
      case "SPORT": {
        // The chips submit an array; everything downstream expects a name.
        const sportName = firstOf(acc.sport_name);
        if (!sportName) return infoScreen("Please pick a sport to continue.");
        return dateScreen(venueId, { ...acc, sport_name: sportName });
      }
      case "DATE": {
        // Each group is its own field, so only the tapped one carries a value.
        // Plain `date` is read too, so anyone mid-booking on the DatePicker
        // version still advances after a redeploy.
        const date = normalizeDate(firstOf(acc.date_g1) || firstOf(acc.date_g2) || acc.date);
        if (!date) return infoScreen("Please pick a date to continue.");
        return courtOrTimeScreen(venueId, { ...acc, date });
      }
      case "COURT": {
        const courtId = firstOf(acc.court_id);
        if (!courtId) return infoScreen("Please pick a court to continue.");
        return timeScreen(venueId, { ...acc, court_id: courtId });
      }
      case "TIME": {
        const startTime = firstOf(acc.start_time);
        if (!startTime) return infoScreen("Please pick a start time to continue.");
        return durationScreen(venueId, { ...acc, start_time: startTime });
      }
      case "DURATION": {
        const duration = firstOf(acc.duration);
        if (!duration) return infoScreen("Please pick a duration to continue.");
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
