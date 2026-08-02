import express from "express";
import morgan from "morgan";

import { config } from "./config.js";
import { logInfo } from "./logger.js";
import { sendTemplateHelloWorld } from "./whatsapp.js";
import { webhookRouter } from "./webhook.js";
import { paymentNotifyRouter } from "./payment-notify.js";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    }
  })
);
app.use(morgan("combined"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-test-webhook",
    graphApiVersion: config.graphApiVersion,
    signatureValidationEnabled: config.validateMetaSignature
  });
});

app.post("/send-template", async (req, res, next) => {
  try {
    const { to, phone_number_id: phoneNumberId } = req.body;
    if (!to) {
      res.status(400).json({ error: "Missing required body field: to" });
      return;
    }
    // Sends are per-venue now: this manual test endpoint needs the sending
    // number so resolveAccessToken can find that venue's token.
    if (!phoneNumberId) {
      res.status(400).json({ error: "Missing required body field: phone_number_id" });
      return;
    }

    const result = await sendTemplateHelloWorld(to, phoneNumberId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use("/webhook", webhookRouter);
app.use("/payment-notify", paymentNotifyRouter);

app.use((err, _req, res, _next) => {
  const status = err.response?.status || 500;
  res.status(status).json({
    error: "Request failed",
    details: err.response?.data || err.message
  });
});

app.listen(config.port, () => {
  logInfo(`WhatsApp test webhook listening on http://localhost:${config.port}`);
  logInfo("Health check available", { url: `http://localhost:${config.port}/health` });
});
