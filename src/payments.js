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
    return response.data;
  } catch (error) {
    logError("createOrder failed", {
      amountRupees,
      status: error?.response?.status,
      error: error?.message
    });
    return null;
  }
}

// Builds the hosted checkout URL the customer opens to pay. Mirrors the
// parameters app/(tabs)/webViewRazorpay.tsx passes to the checkout page:
// `amount` is the Razorpay order amount (paise), taken straight from the
// created order.
export function buildCheckoutUrl({ orderId, amount, currency = "INR", name, contact }) {
  const params = new URLSearchParams({
    order_id: orderId,
    amount: String(amount),
    currency,
    name: name || "",
    contact: contact || "",
    prefer: "upi"
  });
  return `${config.checkoutBaseUrl}?${params.toString()}`;
}
