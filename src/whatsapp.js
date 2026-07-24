import axios from "axios";
import { config, assertCanSendMessages } from "./config.js";
import { logInfo } from "./logger.js";

function messagesUrl() {
  return `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
}

async function sendMessage(payload) {
  assertCanSendMessages();

  const response = await axios.post(messagesUrl(), payload, {
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });

  logInfo("WhatsApp message sent", response.data);
  return response.data;
}

export async function sendTextMessage(to, body) {
  return sendMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      preview_url: false,
      body
    }
  });
}

export async function sendBookingButtons(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: "Choose an option to continue."
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: {
              id: "book_turf",
              title: "Book Turf"
            }
          },
          {
            type: "reply",
            reply: {
              id: "view_slots",
              title: "View Slots"
            }
          },
          {
            type: "reply",
            reply: {
              id: "contact_staff",
              title: "Contact Staff"
            }
          }
        ]
      }
    }
  });
}

export async function sendTemplateHelloWorld(to) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "hello_world",
      language: {
        code: "en_US"
      }
    }
  });
}
