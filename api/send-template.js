import { sendTemplateHelloWorld } from "../src/whatsapp.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { to } = req.body || {};
    if (!to) {
      res.status(400).json({ error: "Missing required body field: to" });
      return;
    }

    const result = await sendTemplateHelloWorld(to);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Request failed",
      details: error.response?.data || error.message
    });
  }
}
