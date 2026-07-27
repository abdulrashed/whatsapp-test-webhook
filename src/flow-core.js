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

// Meta refuses to render a ChipsSelector holding a single option ("dataSource
// array must contain at least 2 options"), so no group may ever be built with
// one chip. Where a screen has only one real choice there is nothing to decide,
// and it is skipped outright.
const MIN_CHIPS_PER_GROUP = 2;

// The rule holds even for a group hidden by `visible: false` — an empty chip
// group leaves the whole screen's form invalid, and an invalid form silently
// blocks every on-select-action on it, so nothing navigates. Unused slots get
// filler that is never rendered and never matches a real id.
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

// Every selection screen renders as ChipsSelector carrying an on-select-action,
// so one tap both records the choice and advances — no screen has a "Next"
// footer, which also makes every selection mandatory (there is no other way
// forward). on-select-action on chips needs Flow JSON >= 7.1. Meta caps a
// ChipsSelector at CHIPS_PER_GROUP options, so long lists (dates, time slots)
// are split across labelled groups.
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
  // A single-sport venue has nothing to choose — open straight on the dates.
  if (sports.length < MIN_CHIPS_PER_GROUP) {
    return dateScreen(venueId, { sport_name: sports[0].id });
  }
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

  // Flow JSON cannot link two selectors, so a window split across groups can be
  // tapped once per group. Whenever the whole window fits in one selector, use
  // one — that makes a single date structurally impossible to violate, and lets
  // the group be `required` (Meta prints "(Optional)" beside every label that
  // isn't). Days past the first month carry their month so nothing is ambiguous.
  const total = byMonth.reduce((n, m) => n + m.days.length, 0);
  if (total <= CHIPS_PER_GROUP) {
    const [first, ...rest] = byMonth;
    return [{
      // "July – August 2026" when the window straddles a month, else "July 2026".
      label: rest.length
        ? `${first.label.replace(/ \d{4}$/, "")} – ${byMonth[byMonth.length - 1].label}`
        : first.label,
      monthKey: first.key,
      days: [
        ...first.days,
        ...rest.flatMap((m) => m.days.map((d) => ({ ...d, title: `${d.title} ${monthAbbrOf(d.id)}` })))
      ]
    }];
  }

  const groups = [];
  for (const month of byMonth) {
    for (let i = 0; i < month.days.length; i += CHIPS_PER_GROUP) {
      groups.push({
        // Continuation chunks repeat no heading; the chips read as one month.
        label: i === 0 ? month.label : " ",
        monthKey: month.key,
        days: month.days.slice(i, i + CHIPS_PER_GROUP)
      });
    }
  }

  // A window can end a day or two into the next month, leaving a stray group
  // Meta won't render. Fold it back into the group before it, tagging the moved
  // chips with their month so the heading above them stays truthful.
  for (let i = groups.length - 1; i > 0; i--) {
    const group = groups[i];
    if (group.days.length >= MIN_CHIPS_PER_GROUP) continue;
    const prev = groups[i - 1];
    const moved = group.days.map((d) =>
      group.monthKey === prev.monthKey ? d : { ...d, title: `${d.title} ${monthAbbrOf(d.id)}` }
    );
    if (prev.days.length + moved.length <= CHIPS_PER_GROUP) {
      prev.days.push(...moved);
      groups.splice(i, 1);
    } else {
      // The previous group is already full, so lend it chips instead.
      while (group.days.length < MIN_CHIPS_PER_GROUP && prev.days.length > MIN_CHIPS_PER_GROUP) {
        const lent = prev.days.pop();
        group.days.unshift(
          group.monthKey === prev.monthKey ? lent : { ...lent, title: `${lent.title} ${monthAbbrOf(lent.id)}` }
        );
      }
    }
  }
  return groups.slice(0, DATE_CHIP_GROUPS);
}

function monthAbbrOf(isoDate) {
  return MONTH_ABBR[Number(isoDate.slice(5, 7)) - 1];
}

async function dateScreen(venueId, acc) {
  const venue = await fetchVenueDetails(venueId);
  const groups = buildDateChipGroups(venue?.days_count);
  if (!groups.length) return infoScreen("This venue isn't open for booking right now.");
  // A one-day window can't be a chip group and isn't a choice — take it.
  if (groups.length === 1 && groups[0].days.length < MIN_CHIPS_PER_GROUP) {
    return courtOrTimeScreen(venueId, { ...acc, date: groups[0].days[0].id });
  }

  // Meta labels every non-required field "(Optional)", which is wrong here —
  // there is no footer, so a date must be chosen. It can only be marked
  // required when it is the sole group, otherwise picking a date in a later
  // month would leave the required one empty and block the tap.
  const data = { sport_name: acc.sport_name, g1_required: groups.length === 1 };
  for (let i = 0; i < DATE_CHIP_GROUPS; i++) {
    const group = groups[i];
    const n = i + 1;
    data[`g${n}_label`] = group?.label || " ";
    data[`g${n}_days`] = group?.days || UNUSED_CHIPS;
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
  // The only free slot is not a choice — take it and ask for the duration.
  if (times.length < MIN_CHIPS_PER_GROUP) {
    return durationScreen(venueId, { ...acc, court_name: courtName, start_time: times[0].slot_time });
  }

  const [first, second] = buildTimeChipGroups(times);
  return {
    screen: "TIME",
    data: {
      times_am: first.items,
      times_pm: second?.items || UNUSED_CHIPS,
      am_label: first.label,
      pm_label: second?.label || " ",
      am_required: !second,
      am_visible: true,
      pm_visible: Boolean(second),
      sport_name: acc.sport_name,
      date: acc.date,
      court_id: acc.court_id,
      court_name: courtName
    }
  };
}

// Splitting the day at noon reads well, but only when both halves can actually
// render — a morning holding one slot would be dropped by Meta. So split only
// when the list genuinely outgrows a single selector, and fall back to an even
// two-way split when the noon halves are lopsided.
function buildTimeChipGroups(times) {
  const chip = (t) => ({ id: t.slot_time, title: to12h(t.slot_time) });
  if (times.length <= CHIPS_PER_GROUP) {
    return [{ label: "Start time", items: times.map(chip) }];
  }

  const am = times.filter((t) => Number(t.slot_time.split(":")[0]) < 12);
  const pm = times.filter((t) => Number(t.slot_time.split(":")[0]) >= 12);
  const fits = (list) => list.length >= MIN_CHIPS_PER_GROUP && list.length <= CHIPS_PER_GROUP;
  if (fits(am) && fits(pm)) {
    return [
      { label: "Morning", items: am.map(chip) },
      { label: "Afternoon & Evening", items: pm.map(chip) }
    ];
  }

  const capped = times.slice(0, CHIPS_PER_GROUP * 2);
  const half = Math.ceil(capped.length / 2);
  return [
    { label: "Start time", items: capped.slice(0, half).map(chip) },
    { label: " ", items: capped.slice(half).map(chip) }
  ];
}

// Offer only durations whose whole span is still free (re-checked live).
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
      // Kept short so it reads as a chip rather than wrapping to a full row.
      title: `${h}h · till ${to12hShort(end)} · ₹${price}`
    });
  }
  if (!durations.length) {
    return infoScreen("That start time is no longer available. Please try another.");
  }
  // Only one length fits before the next booking — go straight to the summary,
  // where the customer still sees it and confirms before paying.
  if (durations.length < MIN_CHIPS_PER_GROUP) {
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
    switch (screen) {
      // The guards below are belt-and-braces: every screen advances from an
      // on-select-action, so a request only arrives once something is selected.
      // They must not re-return their own screen — Meta rejects a routing model
      // where a screen routes to itself ("Loop detected in the routing model").
      case "SPORT": {
        const sportName = firstOf(acc.sport_name);
        if (!sportName) return infoScreen("Please pick a sport to continue.");
        return dateScreen(venueId, { ...acc, sport_name: sportName });
      }
      case "DATE": {
        // Each month group is its own ChipsSelector and fires independently, so
        // only the tapped group's field is present in the payload.
        const raw = firstOf(acc.date_g1) || firstOf(acc.date_g2)
          || firstOf(acc.date_g3) || firstOf(acc.date_g4);
        const date = normalizeDate(raw);
        if (!date) return infoScreen("Please pick a date to continue.");
        return courtOrTimeScreen(venueId, { ...acc, date });
      }
      case "COURT": {
        const courtId = firstOf(acc.court_id);
        if (!courtId) return infoScreen("Please pick a court to continue.");
        return timeScreen(venueId, { ...acc, court_id: courtId });
      }
      case "TIME": {
        // Slots are split across a morning and an afternoon/evening group.
        const startTime = firstOf(acc.start_time_am) || firstOf(acc.start_time_pm);
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
