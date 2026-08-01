import crypto from "crypto";
import express from "express";

import { config } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { fetchBookingByOrderId, markConfirmationSent } from "./booking.js";
import { sendBookingConfirmation } from "./whatsapp.js";

export const paymentNotifyRouter = express.Router();

// v2_webhook_live.php presents "sha256=<hex>" of the raw body, keyed with the
// shared PAYMENT_NOTIFY_SECRET (see docs/FLOW_SETUP.md §7). Empty secret means
// the endpoint trusts nobody and refuses every request.
export function isValidPaymentNotifySignature({ rawBody, signatureHeader }) {
  if (!config.paymentNotifySecret) {
    logWarn("PAYMENT_NOTIFY_SECRET missing; refusing /payment-notify");
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", config.paymentNotifySecret)
    .update(rawBody || Buffer.from(""))
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

// Razorpay's webhook stays the source of truth for money and for promoting the
// booking to "online" on capture; this endpoint only fires the WhatsApp
// confirmation. It answers 200 on success AND on every benign skip (unknown
// order, non-WhatsApp booking, already sent) so the caller never has cause to
// retry — 401 only for a bad signature, 400 only for malformed input.
paymentNotifyRouter.post("/", async (req, res) => {
  if (
    !isValidPaymentNotifySignature({
      rawBody: req.rawBody,
      signatureHeader: req.get("x-gameon-signature")
    })
  ) {
    logWarn("Invalid /payment-notify signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { order_id: orderId, status } = req.body || {};
  if (!orderId) {
    res.status(400).json({ error: "Missing order_id" });
    return;
  }

  // Only a captured payment means a confirmed booking. Anything else is a
  // benign no-op the caller should not retry.
  if (status && status !== "captured") {
    logInfo("payment-notify ignored non-captured status", { orderId, status });
    res.status(200).json({ ok: true, skipped: "not-captured" });
    return;
  }

  try {
    const booking = await fetchBookingByOrderId(orderId);
    if (!booking) {
      logWarn("payment-notify: no booking for order", { orderId });
      res.status(200).json({ ok: true, skipped: "booking-not-found" });
      return;
    }
    if (booking.source !== "whatsapp" || !booking.wa_id) {
      res.status(200).json({ ok: true, skipped: "not-whatsapp" });
      return;
    }
    if (booking.wa_confirmation_sent_at) {
      res.status(200).json({ ok: true, skipped: "already-sent" });
      return;
    }

    await sendBookingConfirmation(booking.wa_id, booking, booking.wa_phone_number_id);
    await markConfirmationSent(booking.id);
    logInfo("Booking confirmation sent", { orderId, bookingId: booking.id, to: booking.wa_id });
    res.status(200).json({ ok: true, sent: true });
  } catch (error) {
    // The send itself failed (not a skip). Stay un-stamped so a later delivery
    // can still go out; surface it as 500 for our own logs. The PHP caller
    // ignores the response, so this never blocks or retries the payment.
    logError("payment-notify send failed", { orderId, error: error?.response?.data || error?.message });
    res.status(500).json({ error: "Send failed" });
  }
});
