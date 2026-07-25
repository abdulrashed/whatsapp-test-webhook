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
