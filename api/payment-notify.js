import crypto from "crypto";

import { fetchBookingByOrderId, markConfirmationSent } from "../src/booking.js";
import { config as appConfig } from "../src/config.js";
import { logError, logInfo, logWarn } from "../src/logger.js";
import { sendBookingConfirmation } from "../src/whatsapp.js";

// WhatsApp side of a successful payment, deliberately split from the money
// side: v2_webhook_live.php stays the single authority on capture, finance and
// coupons, and calls this endpoint afterwards purely to message the customer.
// A failure here must never fail the payment, so every error path still
// answers 200 unless the caller itself is wrong (bad secret / bad body).
//
// Contract: POST { order_id, status, payment_id } with header
//   x-gameon-signature: sha256=<hmac of the raw body, keyed with
//                              PAYMENT_NOTIFY_SECRET>

export const config = { api: { bodyParser: false } };

const SUCCESS_STATUSES = new Set(["captured", "success", "paid"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!appConfig.paymentNotifySecret) {
    logError("payment-notify hit but PAYMENT_NOTIFY_SECRET is not configured");
    res.status(500).json({ error: "Not configured" });
    return;
  }

  const rawBody = await readRawBody(req);

  if (!isValidSignature(rawBody, req.headers["x-gameon-signature"])) {
    logWarn("payment-notify rejected: bad signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const orderId = body.order_id;
  if (!orderId) {
    res.status(400).json({ error: "Missing order_id" });
    return;
  }

  try {
    const result = await notify(orderId, body);
    logInfo("payment-notify handled", { orderId, ...result });
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    // Swallow: Razorpay would otherwise retry the PHP webhook for a problem
    // that has nothing to do with the payment.
    logError("payment-notify failed", { orderId, error: error?.message });
    res.status(200).json({ ok: false, skipped: "error" });
  }
}

async function notify(orderId, body) {
  if (!SUCCESS_STATUSES.has(String(body.status || "").toLowerCase())) {
    return { skipped: "not-a-success-status" };
  }

  const booking = await fetchBookingByOrderId(orderId);
  if (!booking) return { skipped: "booking-not-found" };

  // App bookings share the same Razorpay order flow but have their own push
  // notification — only WhatsApp-originated bookings get a chat message.
  if (booking.source !== "whatsapp") return { skipped: "not-a-whatsapp-booking" };
  if (booking.wa_confirmation_sent_at) return { skipped: "already-sent" };

  // wa_id is stored from v0 of this change; older processing bookings only have
  // the 10-digit user_id, which is the same number without the country code.
  const to = booking.wa_id || (booking.user_id ? `91${booking.user_id}` : null);
  if (!to) return { skipped: "no-recipient" };

  await sendBookingConfirmation(to, booking, booking.wa_phone_number_id || undefined);
  await markConfirmationSent(booking.id);
  return { bookingId: booking.id, notified: to };
}

function isValidSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto
    .createHmac("sha256", appConfig.paymentNotifySecret)
    .update(rawBody)
    .digest("hex")}`;
  const provided = Buffer.from(String(signatureHeader));
  const digest = Buffer.from(expected);
  return provided.length === digest.length && crypto.timingSafeEqual(provided, digest);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
