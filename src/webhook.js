import express from "express";

import { logError, logWarn } from "./logger.js";
import { handleWebhookPayload, isValidMetaSignature, verifyWebhookQuery } from "./webhook-core.js";

export const webhookRouter = express.Router();

webhookRouter.get("/", (req, res) => {
  const result = verifyWebhookQuery(req.query);

  if (result.ok) {
    res.status(200).send(result.challenge);
    return;
  }

  res.sendStatus(403);
});

webhookRouter.post("/", async (req, res) => {
  if (
    !isValidMetaSignature({
      rawBody: req.rawBody,
      signatureHeader: req.get("x-hub-signature-256")
    })
  ) {
    logWarn("Invalid Meta webhook signature");
    res.sendStatus(403);
    return;
  }

  // Acknowledge quickly so Meta does not retry while we process.
  res.sendStatus(200);

  try {
    await handleWebhookPayload(req.body);
  } catch (error) {
    logError("Webhook processing failed", error);
  }
});
