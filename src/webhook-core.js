import crypto from "crypto";

import { config } from "./config.js";
import { hasSeenEvent } from "./dedupe.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { sendBookingButtons, sendTextMessage } from "./whatsapp.js";

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
    logInfo("Message status received", {
      id: status.id,
      status: status.status,
      timestamp: status.timestamp,
      recipientId: status.recipient_id
    });
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
    await respondToButton(from, message.interactive?.button_reply?.id, phoneNumberId);
    return;
  }

  if (message.type === "text") {
    await sendTextMessage(
      from,
      "Welcome. This is the WhatsApp test booking flow. Please choose an option below.",
      phoneNumberId
    );
    await sendBookingButtons(from, phoneNumberId);
    return;
  }

  await sendTextMessage(from, "Thanks. Please use one of the booking options below.", phoneNumberId);
  await sendBookingButtons(from, phoneNumberId);
}

async function respondToButton(from, buttonId, phoneNumberId) {
  switch (buttonId) {
    case "book_turf":
      await sendTextMessage(
        from,
        "Booking test selected. Next stage will connect court selection and live availability.",
        phoneNumberId
      );
      break;
    case "view_slots":
      await sendTextMessage(
        from,
        "Slot viewing test selected. Next stage will fetch available slots from the booking system.",
        phoneNumberId
      );
      break;
    case "contact_staff":
      await sendTextMessage(
        from,
        "Staff contact test selected. A team member handoff can be added later.",
        phoneNumberId
      );
      break;
    default:
      await sendTextMessage(
        from,
        "Button received. Please send Hi to restart the test flow.",
        phoneNumberId
      );
  }
}
