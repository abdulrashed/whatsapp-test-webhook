import axios from "axios";
import { config } from "./config.js";
import { logInfo } from "./logger.js";
import { resolveAccessToken, toTitleCase } from "./venues.js";

function messagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${config.graphApiVersion}/${phoneNumberId}/messages`;
}

// The sender number and its access token both key off phone_number_id: each
// number sends from its own /{phoneNumberId}/messages endpoint authorized by
// its own WABA token (resolveAccessToken reads it from the number's venue doc).
// Callers must pass the phoneNumberId that received the message — there is no
// global sender — but they never handle tokens themselves.
async function sendMessage(payload, phoneNumberId) {
  const senderId = phoneNumberId;
  const token = await resolveAccessToken(phoneNumberId);

  if (!senderId || !token) {
    throw new Error(
      `Cannot send WhatsApp message. Missing ${!senderId ? "phone_number_id" : "access token"} for this number.`
    );
  }

  const response = await axios.post(messagesUrl(senderId), payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });

  logInfo("WhatsApp message sent", { senderId, ...response.data });
  return response.data;
}

export async function sendTextMessage(to, body, phoneNumberId) {
  return sendMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        preview_url: false,
        body
      }
    },
    phoneNumberId
  );
}

// The greeting lives in the interactive body rather than a separate text message:
// api/webhook.js awaits every send before ACKing Meta, so one call instead of two
// halves that window and keeps the menu from arriving as two chat bubbles.
export async function sendMainMenu(to, venueName, phoneNumberId) {
  return sendMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text:
            `👋 Welcome to *${venueName}*!\n\n` +
            "Great to have you here. You can book a turf in seconds, check your existing bookings, or chat with our team.\n\n" +
            "How can we help you today? 👇"
        },
        action: {
          // Max 3 reply buttons, titles capped at 20 characters by WhatsApp.
          buttons: [
            { type: "reply", reply: { id: "book_slot", title: "Book a Slot" } },
            { type: "reply", reply: { id: "my_bookings", title: "My Bookings" } },
            { type: "reply", reply: { id: "chat_venue", title: "Chat with Venue" } }
          ]
        }
      }
    },
    phoneNumberId
  );
}

// Sends a single call-to-action URL button (used to open the hosted Razorpay
// checkout page). WhatsApp allows exactly one URL button per CTA message.
export async function sendCtaUrl(to, bodyText, buttonText, url, phoneNumberId) {
  return sendMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: bodyText },
        action: {
          name: "cta_url",
          parameters: { display_text: buttonText, url }
        }
      }
    },
    phoneNumberId
  );
}

// "18:30" -> "6:30 PM", dropping a ":00" that buys nothing.
function to12h(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h)) return String(hhmm);
  const period = h >= 12 && h < 24 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${period}`;
}

// "2026-07-30" -> "Thu, 30 Jul". Today and tomorrow are named instead, since
// that is what a customer checking their bookings actually cares about.
function friendlyDate(dateStr, today = new Date()) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((d - midnight) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${weekday}, ${d.getDate()} ${month}`;
}

// "Legends Arena · Court 1", or just the venue when the court carries the same
// name — single-court venues in this Firestore store court_name == venue_name,
// which would otherwise render as "Legends Arena · LEGENDS ARENA".
function venueAndCourt(venueName, courtName) {
  const venue = venueName ? toTitleCase(venueName) : "Venue";
  const court = courtName ? toTitleCase(courtName) : "";
  if (!court || court.toLowerCase() === venue.toLowerCase()) return venue;
  return `${venue} · ${court}`;
}

// The "My Bookings" reply. Pure so the copy can be tested without a send, and
// so it can become a template body later. `bookings` is already filtered to
// upcoming confirmed ones and sorted soonest-first by fetchUpcomingBookings.
export function buildUpcomingBookingsText(bookings) {
  if (!bookings?.length) {
    return (
      "📭 You don't have any upcoming bookings yet.\n\n" +
      "Tap *Book a Slot* from the menu to grab your next game — type *menu* to bring it back. 🏟️"
    );
  }

  const lines = bookings.map((b) => {
    const paid = Number(b.paid_amount) || 0;
    const total = Number(b.final_amount) || 0;
    const balance = Math.max(total - paid, 0);
    return (
      `🏟️ *${venueAndCourt(b.venue_name, b.court_name)}*\n` +
      (b.sport?.name ? `🎾 ${b.sport.name}\n` : "") +
      `📅 ${friendlyDate(b.date)} · ⏰ ${to12h(b.start_time)} – ${to12h(b.end_time)}` +
      (balance > 0 ? `\n💵 Balance ₹${balance} payable at the venue` : "")
    );
  });

  const heading = bookings.length === 1 ? "📋 *Your upcoming booking*" : "📋 *Your upcoming bookings*";
  return `${heading}\n\n${lines.join("\n\n")}\n\nType *menu* for more options.`;
}

// Confirmation copy, kept pure so it can be reused as the body parameter of an
// approved template later without touching the transport.
export function buildBookingConfirmationText(booking) {
  const paid = Number(booking.paid_amount) || 0;
  const total = Number(booking.final_amount) || 0;
  const balance = Math.max(total - paid, 0);
  return (
    `✅ *Booking confirmed!*\n\n` +
    `🏟️ ${venueAndCourt(booking.venue_name, booking.court_name)}\n` +
    `🎾 ${booking.sport?.name || ""}\n` +
    `📅 ${friendlyDate(booking.date)}\n` +
    `⏰ ${to12h(booking.start_time)} – ${to12h(booking.end_time)}\n` +
    `💳 Paid ₹${paid}` +
    (balance > 0 ? `\n💵 Balance ₹${balance} payable at the venue` : "") +
    (booking.venue_contact ? `\n\n📞 ${booking.venue_contact}` : "") +
    `\n\nSee you on the turf! 🎉`
  );
}

// Sent by the Razorpay webhook relay moments after capture, so the 24-hour
// customer-service window is still open and a free-form message is allowed —
// no approved template needed. Swap sendTextMessage for sendBookingTemplate
// here if confirmations ever have to go out later than that.
export async function sendBookingConfirmation(to, booking, phoneNumberId) {
  return sendBookingTemplate(to, booking, phoneNumberId);
}

// The approved `booking_confirmed` template (see scripts/create-template.js for
// its canonical shape). Unlike sendBookingConfirmation's free-form text, a
// template can be delivered outside the 24-hour service window and carries the
// "My Bookings" / "Book Again" quick-reply buttons.
//
// Only the BODY takes parameters — the header, footer and buttons are static.
// Two things MUST match how the template was registered on Meta or the send is
// rejected (error 132000/132001):
//   - parameter style: NAMED here (parameter_name). If the template was created
//     with numbered {{1}}..{{6}} instead, drop parameter_name and keep this
//     exact order: venue, sport, date, time, paid, total.
//   - language.code: "en" here. Must equal the template's language.
// Named param values may not contain a newline, tab, or 4+ spaces (Meta rule),
// which the fields below all satisfy.
export async function sendBookingTemplate(to, booking, phoneNumberId) {
  const paid = Number(booking.paid_amount) || 0;
  const total = Number(booking.final_amount) || 0;
  return sendMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: "booking_confirmed",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", parameter_name: "venue", text: venueAndCourt(booking.venue_name, booking.court_name) },
              { type: "text", parameter_name: "sport", text: booking.sport?.name || "" },
              { type: "text", parameter_name: "date", text: friendlyDate(booking.date) },
              { type: "text", parameter_name: "time", text: `${to12h(booking.start_time)} – ${to12h(booking.end_time)}` },
              { type: "text", parameter_name: "paid", text: String(paid) },
              { type: "text", parameter_name: "total", text: String(total) }
            ]
          }
        ]
      }
    },
    phoneNumberId
  );
}

// Sends an interactive Flow message that opens the booking Flow in-app. The
// flow_token carries venue + user identity back to our endpoint; mode
// "navigate" with our INIT-driven endpoint means Meta calls the endpoint for
// the first screen. flowCta is the button label the customer taps.
export async function sendFlowMessage(
  to,
  { flowId, flowToken, flowCta = "Book a Slot", bodyText, header },
  phoneNumberId
) {
  return sendMessage(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        ...(header ? { header: { type: "text", text: header } } : {}),
        body: { text: bodyText || "Tap below to book your slot." },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: flowToken,
            flow_id: flowId,
            flow_cta: flowCta,
            flow_action: "data_exchange"
          }
        }
      }
    },
    phoneNumberId
  );
}

export async function sendTemplateHelloWorld(to, phoneNumberId) {
  return sendMessage(
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "hello_world",
        language: {
          code: "en_US"
        }
      }
    },
    phoneNumberId
  );
}
