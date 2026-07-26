import { sendTemplateHelloWorld } from "../src/whatsapp.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { to, phoneNumberId, from } = req.body || {};
    if (!to) {
      res.status(400).json({ error: "Missing required body field: to" });
      return;
    }

    // Optional: choose which of your numbers sends. Falls back to the
    // configured WHATSAPP_PHONE_NUMBER_ID when omitted.
    const senderId = phoneNumberId || from;

    const result = await sendTemplateHelloWorld(to, senderId);
    res.status(200).json({ senderId: senderId || "default (WHATSAPP_PHONE_NUMBER_ID)", ...result });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Request failed",
      details: error.response?.data || error.message
    });
  }
}
