import crypto from "crypto";

import { config } from "./config.js";
import { hasSeenEvent } from "./dedupe.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { sendMainMenu, sendTextMessage } from "./whatsapp.js";

export function verifyWebhookQuery(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (mode === "subscribe" && token === config.verifyToken) {
    logInfo("Webhook verified by Meta");
    return { ok: true, challenge };
  }

  logWarn("Webhook verification failed", { mode, tokenProvided: Boolean(token) });
  return { ok: false };
}

export function isValidMetaSignature({ rawBody, signatureHeader }) {
  if (!config.validateMetaSignature) {
    return true;
  }

  if (!config.metaAppSecret) {
    logWarn("META_APP_SECRET missing while signature validation is enabled");
    return false;
  }

  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", config.metaAppSecret)
    .update(rawBody || Buffer.from(""))
    .digest("hex");

  const receivedSignature = signatureHeader.replace("sha256=", "");
  if (receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(receivedSignature, "hex"),
    Buffer.from(expectedSignature, "hex")
  );
}

export async function handleWebhookPayload(payload) {
  if (payload.object !== "whatsapp_business_account") {
    logInfo("Ignoring non-WhatsApp webhook payload", { object: payload.object });
    return;
  }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") {
        logInfo("Ignoring unsupported webhook field", { field: change.field });
        continue;
      }

      await handleMessagesChange(change.value || {});
    }
  }
}

async function handleMessagesChange(value) {
  // The number that RECEIVED the message. The webhook is subscribed at WABA level,
  // so this differs per inbound message when the account has multiple numbers.
  const phoneNumberId = value.metadata?.phone_number_id;

  for (const status of value.statuses || []) {
    const statusEventId = `status:${status.id}:${status.status}`;
    if (hasSeenEvent(statusEventId)) {
      logInfo("Duplicate status ignored", { statusEventId });
      continue;
    }
    const statusDetails = {
      id: status.id,
      status: status.status,
      timestamp: status.timestamp,
      recipientId: status.recipient_id
    };

    // A "failed" status carries the real reason a 200-accepted message
    // never reached the recipient (wrong format, no WhatsApp, template
    // not approved, recipient not on a test number's allow-list, etc.).
    if (status.status === "failed" || status.errors?.length) {
      logError("WhatsApp message delivery failed", {
        ...statusDetails,
        errors: status.errors
      });
      continue;
    }

    logInfo("Message status received", statusDetails);
  }

  for (const message of value.messages || []) {
    const messageEventId = `message:${message.id}`;
    if (hasSeenEvent(messageEventId)) {
      logInfo("Duplicate inbound message ignored", { messageEventId });
      continue;
    }

    const from = message.from;
    logInfo("Inbound WhatsApp message received", {
      from,
      phoneNumberId,
      displayPhoneNumber: value.metadata?.display_phone_number,
      type: message.type,
      id: message.id,
      text: message.text?.body,
      buttonId: message.interactive?.button_reply?.id,
      buttonTitle: message.interactive?.button_reply?.title
    });

    try {
      await respondToMessage(from, message, phoneNumberId);
    } catch (error) {
      logError("Failed to respond to inbound WhatsApp message", error);
    }
  }
}

async function respondToMessage(from, message, phoneNumberId) {
  if (!from) {
    logWarn("Inbound message missing sender number");
    return;
  }

  if (!phoneNumberId) {
    logWarn("Inbound message missing metadata.phone_number_id, skipping reply", { from });
    return;
  }

  if (message.type === "interactive") {
    // Read both reply shapes: taps on the three-button menu arrive as
    // button_reply, while list rows (used later for My Bookings) arrive as
    // list_reply. Reading only button_reply would drop list selections into
    // the default branch.
    const replyId =
      message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
    await respondToButton(from, replyId, phoneNumberId);
    return;
  }

  if (message.type === "text") {
    // Any text (Hi, hello, menu, or a stray message) shows the menu for now.
    // Phase 1 adds a session so "human" mode keeps the bot quiet after a handoff.
    await sendMainMenu(from, config.venueName, phoneNumberId);
    return;
  }

  await sendMainMenu(from, config.venueName, phoneNumberId);
}

async function respondToButton(from, buttonId, phoneNumberId) {
  switch (buttonId) {
    case "book_slot":
      await sendTextMessage(
        from,
        "Great — let's book your slot. The booking form opens here next; we're wiring it up now.",
        phoneNumberId
      );
      break;
    case "my_bookings":
      await sendTextMessage(
        from,
        "You'll be able to view your upcoming bookings here shortly.",
        phoneNumberId
      );
      break;
    case "chat_venue":
      await sendTextMessage(
        from,
        `You're now connected to *${config.venueName}*. Please type your question and our team will get back to you shortly.\n\n` +
          "Type *menu* anytime to return to the main options.",
        phoneNumberId
      );
      break;
    default:
      await sendMainMenu(from, config.venueName, phoneNumberId);
  }
}
