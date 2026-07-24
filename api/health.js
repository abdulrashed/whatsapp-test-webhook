import { config } from "../src/config.js";

export default function handler(_req, res) {
  res.status(200).json({
    ok: true,
    service: "whatsapp-test-webhook",
    runtime: "vercel",
    graphApiVersion: config.graphApiVersion,
    phoneNumberIdConfigured: Boolean(config.phoneNumberId),
    wabaIdConfigured: Boolean(config.wabaId),
    signatureValidationEnabled: config.validateMetaSignature
  });
}
