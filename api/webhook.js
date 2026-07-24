import { logError, logWarn } from "../src/logger.js";
import { handleWebhookPayload, isValidMetaSignature, verifyWebhookQuery } from "../src/webhook-core.js";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  if (req.method === "GET") {
    const result = verifyWebhookQuery(req.query);

    if (result.ok) {
      res.status(200).send(result.challenge);
      return;
    }

    res.status(403).send("Forbidden");
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);

  if (
    !isValidMetaSignature({
      rawBody,
      signatureHeader: req.headers["x-hub-signature-256"]
    })
  ) {
    logWarn("Invalid Meta webhook signature");
    res.status(403).send("Forbidden");
    return;
  }

  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    await handleWebhookPayload(payload);
    res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    logError("Vercel webhook processing failed", error);
    res.status(500).send("Webhook processing failed");
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
