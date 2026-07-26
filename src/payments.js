import axios from "axios";

import { config } from "./config.js";
import { logError } from "./logger.js";

// Creates a Razorpay order via the existing GameOn PHP backend
// (v2_create_order_live.php), the same endpoint the app uses. Returns the
// order object ({ id, amount, currency, ... }) or null on failure.
//
// amount is in rupees; the PHP endpoint converts to paise. We mirror the app's
// contract, which POSTs { amount }.
export async function createOrder(amountRupees) {
  try {
    const response = await axios.post(
      config.createOrderUrl,
      { amount: amountRupees },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    // The PHP endpoint wraps the Razorpay order: { success, order: { id, ... } }.
    // Mirror the app (paymentSummary.tsx): gate on `success`, return `order`.
    const data = response.data;
    if (!data?.success || !data.order?.id) {
      logError("createOrder returned no order", { amountRupees, data });
      return null;
    }
    return data.order;
  } catch (error) {
    logError("createOrder failed", {
      amountRupees,
      status: error?.response?.status,
      error: error?.message
    });
    return null;
  }
}

// A Flow cannot launch GPay/PhonePe itself (no intent action) and a WhatsApp
// CTA button only accepts http/https, so `upi://` links can't be sent either.
// Instead the SUMMARY screen records a preference and we pass it to the hosted
// checkout page, which uses it to preselect the method/app in Razorpay
// Checkout. Unknown or missing values fall back to plain UPI.
const PAY_METHODS = {
  gpay: { prefer: "upi", upi_app: "google_pay" },
  phonepe: { prefer: "upi", upi_app: "phonepe" },
  paytm: { prefer: "upi", upi_app: "paytm" },
  upi: { prefer: "upi" },
  card: { prefer: "card" }
};

export function resolvePayMethod(payMethod) {
  // ChipsSelector submits an array even with max-selected-items: 1.
  const raw = Array.isArray(payMethod) ? payMethod[0] : payMethod;
  const key = String(raw || "").toLowerCase();
  return PAY_METHODS[key] || PAY_METHODS.upi;
}

// Builds the hosted checkout URL the customer opens to pay. Mirrors the
// parameters app/(tabs)/webViewRazorpay.tsx passes to the checkout page:
// `amount` is the Razorpay order amount (paise), taken straight from the
// created order.
export function buildCheckoutUrl({
  orderId,
  amount,
  currency = "INR",
  name,
  contact,
  payMethod
}) {
  const { prefer, upi_app: upiApp } = resolvePayMethod(payMethod);
  const params = new URLSearchParams({
    order_id: orderId,
    amount: String(amount),
    currency,
    name: name || "",
    contact: contact || "",
    prefer
  });
  if (upiApp) params.set("upi_app", upiApp);
  return `${config.checkoutBaseUrl}?${params.toString()}`;
}
