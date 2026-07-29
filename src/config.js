import dotenv from "dotenv";

dotenv.config();

const required = [
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_WABA_ID",
  "WHATSAPP_VERIFY_TOKEN"
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.warn(
    `[config] Missing env values: ${missing.join(", ")}. Copy .env.example to .env and fill them before testing Meta calls.`
  );
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  graphApiVersion: process.env.GRAPH_API_VERSION || "v25.0",
  whatsappToken: process.env.WHATSAPP_TOKEN || "",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  wabaId: process.env.WHATSAPP_WABA_ID || "",
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
  metaAppSecret: process.env.META_APP_SECRET || "",
  validateMetaSignature: process.env.VALIDATE_META_SIGNATURE !== "false",
  // Fallback venue used when no venue_details doc carries the incoming
  // phone_number_id. This is the venue_details DOCUMENT ID (the venueId used
  // throughout the GameOn app), not a display name — the name is read from the
  // doc so it never drifts from Firestore. Empty means no fallback: an
  // unmapped number gets a generic greeting and cannot book.
  fallbackVenueId: process.env.VENUE_ID || "",
  // How long a "chat with venue" handoff keeps the bot silent before it
  // resumes on its own (customer can also type "menu" to resume immediately).
  humanModeTtlMs: Number(process.env.HUMAN_MODE_TTL_MS || 6 * 60 * 60 * 1000),
  // WhatsApp Flow endpoint. FLOW_PRIVATE_KEY is the RSA private key (PEM) whose
  // public half is uploaded to Meta; \n may be escaped in the env var. FLOW_ID
  // is the published Flow's id, used when sending the Flow message.
  flowId: process.env.FLOW_ID || "",
  flowPrivateKey: (process.env.FLOW_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  flowKeyPassphrase: process.env.FLOW_KEY_PASSPHRASE || "",
  // Base URL of the hosted Razorpay checkout page (v2_checkout_live.html).
  checkoutBaseUrl:
    process.env.CHECKOUT_BASE_URL || "https://eleganzainfotech.com/v2_checkout_live.html",
  createOrderUrl:
    process.env.CREATE_ORDER_URL || "https://eleganzainfotech.com/v2_create_order_live.php",
  // Shared secret v2_webhook_live.php presents on /payment-notify. The webhook
  // stays the authority on money; this endpoint only sends the WhatsApp
  // confirmation. Empty means the endpoint refuses every request.
  paymentNotifySecret: process.env.PAYMENT_NOTIFY_SECRET || "",
  // Firebase Web config for the GameOn project (turf-app-930c5). These are
  // public client identifiers (already shipped in the app bundle), not secrets;
  // env vars let a different project be pointed at without a code change.
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyAMzw-tuYosbt0LOLo4vfRC0KB86BJDdv4",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "turf-app-930c5.firebaseapp.com",
    projectId: process.env.FIREBASE_PROJECT_ID || "turf-app-930c5",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "turf-app-930c5.firebasestorage.app",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "355894469860",
    appId: process.env.FIREBASE_APP_ID || "1:355894469860:web:a268daa36bb5eb29a778f1"
  }
};

export function assertCanSendMessages() {
  const sendRequired = ["whatsappToken", "phoneNumberId"];
  const missingSendValues = sendRequired.filter((key) => !config[key]);

  if (missingSendValues.length > 0) {
    throw new Error(`Cannot send WhatsApp message. Missing config: ${missingSendValues.join(", ")}`);
  }
}
