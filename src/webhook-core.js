import crypto from "crypto";

import {
  addToBlockConcurrentBookings,
  createProcessingBooking,
  fetchCourtDetails,
  fetchUserById,
  fetchVenueDetails,
  isBookingSlotAvailable,
  sportsForCourts,
  updateBookingOrderId,
  waIdToUserId
} from "./booking.js";
import { config } from "./config.js";
import { hasSeenEvent } from "./dedupe.js";
import { buildFlowToken } from "./flow-core.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { buildCheckoutUrl, createOrder } from "./payments.js";
import { getSession, isHumanMode, setMode } from "./session.js";
import { resolveVenue } from "./venues.js";
import { sendCtaUrl, sendFlowMessage, sendMainMenu, sendTextMessage } from "./whatsapp.js";

// Words that bring the customer back to the bot from a "chat with venue" handoff.
const RESET_KEYWORDS = new Set(["menu", "hi", "hello", "start", "back"]);

function isResetKeyword(text) {
  return typeof text === "string" && RESET_KEYWORDS.has(text.trim().toLowerCase());
}

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
      if (change.field === "messages") {
        await handleMessagesChange(change.value || {});
        continue;
      }

      // Coexistence: the venue owner replied to a customer from the WhatsApp
      // Business app. That reply arrives here as an echo, and it means a human
      // has taken over — put that customer in "human" mode so the bot stops
      // auto-replying over the owner.
      if (change.field === "smb_message_echoes") {
        await handleMessageEchoes(change.value || {});
        continue;
      }

      logInfo("Ignoring unsupported webhook field", { field: change.field });
    }
  }
}

// NOTE: the exact echo payload shape is not verified against a live coexistence
// account yet. We defensively pull the customer number from each echo's `to`
// (falling back to `recipient_id`) and mark that conversation human.
async function handleMessageEchoes(value) {
  const phoneNumberId = value.metadata?.phone_number_id;
  const echoes = value.message_echoes || value.messages || [];

  for (const echo of echoes) {
    const customer = echo.to || echo.recipient_id;
    if (!customer) {
      continue;
    }
    const echoEventId = `echo:${echo.id || `${customer}:${echo.timestamp || ""}`}`;
    if (hasSeenEvent(echoEventId)) {
      continue;
    }
    logInfo("Owner replied from Business app, pausing bot", { customer, phoneNumberId });
    await setMode(customer, "human", { phoneNumberId, lastHumanAt: Date.now() });
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

  // A completed Flow arrives as an interactive nfm_reply — handle it before the
  // human-mode check (a submitted booking should always be processed).
  if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
    await handleFlowCompletion(from, message.interactive.nfm_reply, phoneNumberId);
    return;
  }

  const replyId =
    message.type === "interactive"
      ? message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id
      : null;
  const text = message.text?.body;

  // During a "chat with venue" handoff the bot stays silent so the venue owner
  // owns the conversation. A reset keyword (or tapping a menu button) ends the
  // handoff and brings the bot back.
  const session = await getSession(from);
  if (isHumanMode(session) && !replyId && !isResetKeyword(text)) {
    logInfo("Conversation in human mode, bot staying silent", { from });
    return;
  }

  const { venueId, venueName } = await resolveVenue(phoneNumberId);

  if (replyId) {
    await respondToButton(from, replyId, phoneNumberId, venueName, venueId);
    return;
  }

  // Any text (Hi, hello, menu, or a stray message) resets to the menu.
  await setMode(from, "bot", { phoneNumberId });
  await sendMainMenu(from, venueName, phoneNumberId);
}

async function respondToButton(from, buttonId, phoneNumberId, venueName, venueId) {
  switch (buttonId) {
    case "book_slot":
      await setMode(from, "bot", { phoneNumberId });
      if (config.flowId && venueId) {
        await sendFlowMessage(
          from,
          {
            flowId: config.flowId,
            flowToken: buildFlowToken(venueId, from),
            flowCta: "Book a Slot",
            header: venueName,
            bodyText: "Let's get your slot booked. Tap below to pick your sport, date and time. ⚡"
          },
          phoneNumberId
        );
      } else {
        await sendTextMessage(
          from,
          "Booking isn't fully set up for this number yet — please try again shortly.",
          phoneNumberId
        );
      }
      break;
    case "my_bookings":
      await setMode(from, "bot", { phoneNumberId });
      await sendTextMessage(
        from,
        "You'll be able to view your upcoming bookings here shortly.",
        phoneNumberId
      );
      break;
    case "chat_venue":
      // Hand off to the venue. Under coexistence the customer's next messages
      // land in the owner's Business app; here we just stop auto-replying.
      await setMode(from, "human", { phoneNumberId, lastHumanAt: Date.now() });
      await sendTextMessage(
        from,
        `✅ You're now connected with the *${venueName}* team!\n\n` +
          "Go ahead and type your message — we'll get back to you as soon as we can. 💬\n\n" +
          "Type *menu* anytime to return to the main options.",
        phoneNumberId
      );
      break;
    default:
      await setMode(from, "bot", { phoneNumberId });
      await sendMainMenu(from, venueName, phoneNumberId);
  }
}

// Processes a submitted booking Flow: re-check availability, place a hold,
// create the provisional booking + Razorpay order, and send the pay link.
async function handleFlowCompletion(from, nfmReply, phoneNumberId) {
  let payload;
  try {
    payload = JSON.parse(nfmReply?.response_json || "{}");
  } catch (error) {
    logWarn("Could not parse Flow response_json", { from, error: error?.message });
    return;
  }

  // The INFO screen (no slots / closed) completes with no start_time — nothing
  // to book.
  if (payload.status === "closed" || !payload.start_time || !payload.court_id) {
    logInfo("Flow completed without a booking selection", { from });
    return;
  }

  const { venueId } = await resolveVenue(phoneNumberId);
  if (!venueId) {
    await sendTextMessage(from, "Sorry, we couldn't complete your booking. Please try again.", phoneNumberId);
    return;
  }

  const [venue, courts] = await Promise.all([
    fetchVenueDetails(venueId),
    fetchCourtDetails(venueId)
  ]);
  const court = courts.find((c) => c.id === payload.court_id);
  if (!venue || !court) {
    await sendTextMessage(from, "Sorry, we couldn't complete your booking. Please try again.", phoneNumberId);
    return;
  }

  // Re-check: the Flow may have been open a while.
  const available = await isBookingSlotAvailable(
    payload.date,
    payload.court_id,
    payload.start_time,
    payload.end_time
  );
  if (!available) {
    await sendTextMessage(
      from,
      "😔 That slot was just taken. Please tap *Book a Slot* to pick another time.",
      phoneNumberId
    );
    return;
  }

  const userId = waIdToUserId(from);
  const existing = await fetchUserById(userId);
  const user = {
    id: userId,
    name: existing?.name || "",
    phone: existing?.phone || userId,
    profile_img_url: existing?.profile_img_url || ""
  };
  const sport =
    sportsForCourts(courts).find((s) => s.name === payload.sport_name) || {
      name: payload.sport_name,
      img: ""
    };

  const price = Number(payload.price) || 0;
  const payAmount = Number(payload.pay_amount) || price;

  // Hold the slot for the 5-minute payment window.
  await addToBlockConcurrentBookings(
    payload.start_time,
    payload.end_time,
    userId,
    payload.date,
    payload.court_id
  );

  const booking = await createProcessingBooking({
    venue,
    court,
    user,
    sport,
    date: payload.date,
    startTime: payload.start_time,
    endTime: payload.end_time,
    slotCost: price,
    finalAmount: price,
    paidAmount: payAmount
  });

  const order = await createOrder(payAmount);
  if (!order?.id) {
    await sendTextMessage(
      from,
      "We couldn't start the payment just now. Please try booking again in a moment.",
      phoneNumberId
    );
    return;
  }
  await updateBookingOrderId(booking.id, order.id);

  const url = buildCheckoutUrl({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency || "INR",
    name: user.name,
    contact: userId
  });

  await sendCtaUrl(
    from,
    `Almost done! 🎉\n\n*${court.name}* · ${payload.sport_name}\n📅 ${payload.date} · ⏰ ${payload.start_time}–${payload.end_time}\n💳 Pay ₹${payAmount} to confirm.`,
    "Pay Now",
    url,
    phoneNumberId
  );
}
