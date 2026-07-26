import axios from "axios";
import { config, assertCanSendMessages } from "./config.js";
import { logInfo } from "./logger.js";

function messagesUrl(phoneNumberId) {
  return `https://graph.facebook.com/${config.graphApiVersion}/${phoneNumberId}/messages`;
}

async function sendMessage(payload, phoneNumberId) {
  assertCanSendMessages();

  const senderId = phoneNumberId || config.phoneNumberId;
  const response = await axios.post(messagesUrl(senderId), payload, {
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
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

// Confirmation copy, kept pure so it can be reused as the body parameter of an
// approved template later without touching the transport.
export function buildBookingConfirmationText(booking) {
  const paid = Number(booking.paid_amount) || 0;
  const total = Number(booking.final_amount) || 0;
  const balance = Math.max(total - paid, 0);
  return (
    `✅ *Booking confirmed!*\n\n` +
    `🏟️ ${booking.venue_name || "Venue"} · ${booking.court_name || "Court"}\n` +
    `🎾 ${booking.sport?.name || ""}\n` +
    `📅 ${booking.date}\n` +
    `⏰ ${booking.start_time} – ${booking.end_time}\n` +
    `💳 Paid ₹${paid}` +
    (balance > 0 ? `\n💵 Balance ₹${balance} payable at the venue` : "") +
    (booking.venue_contact ? `\n\n📞 ${booking.venue_contact}` : "") +
    `\n\nSee you on the turf! 🎉`
  );
}

// Sent by the Razorpay webhook relay moments after capture, so the 24-hour
// customer-service window is still open and a free-form message is allowed —
// no approved template needed. Swap sendTextMessage for a template send here
// if confirmations ever have to go out later than that.
export async function sendBookingConfirmation(to, booking, phoneNumberId) {
  return sendTextMessage(to, buildBookingConfirmationText(booking), phoneNumberId);
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
