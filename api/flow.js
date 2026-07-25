import { config as appConfig } from "../src/config.js";
import { decryptRequest, encryptResponse } from "../src/flow-crypto.js";
import { handleFlowRequest } from "../src/flow-core.js";
import { logError, logWarn } from "../src/logger.js";
import { isValidMetaSignature } from "../src/webhook-core.js";

// Vercel reads this exported `config` to disable body parsing so we can verify
// Meta's signature over the exact raw bytes.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!appConfig.flowPrivateKey) {
    logError("Flow endpoint hit but FLOW_PRIVATE_KEY is not configured");
    res.status(500).send("Flow not configured");
    return;
  }

  const rawBody = await readRawBody(req);

  if (
    !isValidMetaSignature({
      rawBody,
      signatureHeader: req.headers["x-hub-signature-256"]
    })
  ) {
    logWarn("Invalid Meta signature on Flow request");
    res.status(432).send("Signature verification failed");
    return;
  }

  let decrypted;
  try {
    const body = JSON.parse(rawBody.toString("utf8"));
    decrypted = decryptRequest(body, appConfig.flowPrivateKey, appConfig.flowKeyPassphrase);
  } catch (error) {
    // 421 tells WhatsApp to refresh the public key and retry — the right code
    // for a decryption/key mismatch.
    logError("Flow request decryption failed", error);
    res.status(421).send("Decryption failed");
    return;
  }

  try {
    const responseObject = await handleFlowRequest(decrypted.decryptedBody);
    const encrypted = encryptResponse(responseObject, decrypted.aesKey, decrypted.iv);
    res.status(200).setHeader("Content-Type", "text/plain").send(encrypted);
  } catch (error) {
    logError("Flow request handling failed", error);
    res.status(500).send("Flow processing failed");
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
