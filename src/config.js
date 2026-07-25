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
  // Shown in the greeting. Temporary: once venues are onboarded this comes from
  // the wa_numbers/{phone_number_id} lookup so one deployment can serve many venues.
  venueName: process.env.VENUE_NAME || "our venue"
};

export function assertCanSendMessages() {
  const sendRequired = ["whatsappToken", "phoneNumberId"];
  const missingSendValues = sendRequired.filter((key) => !config[key]);

  if (missingSendValues.length > 0) {
    throw new Error(`Cannot send WhatsApp message. Missing config: ${missingSendValues.join(", ")}`);
  }
}
