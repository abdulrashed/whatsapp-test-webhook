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

    // Which of your numbers sends. Required — sends are per-venue now, so the
    // token is resolved from this number's venue_details doc. There is no
    // global default sender.
    const senderId = phoneNumberId || from;
    if (!senderId) {
      res.status(400).json({ error: "Missing required body field: phoneNumberId" });
      return;
    }

    const result = await sendTemplateHelloWorld(to, senderId);
    res.status(200).json({ senderId, ...result });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Request failed",
      details: error.response?.data || error.message
    });
  }
}
