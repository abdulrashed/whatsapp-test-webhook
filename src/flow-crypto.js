import crypto from "crypto";

// Implements Meta's WhatsApp Flow endpoint encryption contract.
//
// Each request carries an AES key RSA-encrypted with our public key, plus a
// Flow-data payload AES-GCM-encrypted under that key. We RSA-decrypt the AES
// key with our private key, AES-decrypt the payload, and for the response
// re-encrypt with the SAME AES key but the initialization vector bit-flipped
// (Meta's required convention). No third-party crypto — Node's built-in only.
//
// Ref: developers.facebook.com/docs/whatsapp/flows/reference/implementingyourflowendpoint

const TAG_LENGTH = 16; // AES-GCM auth tag length in bytes

export function decryptRequest(body, privatePem, passphrase) {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

  const privateKey = crypto.createPrivateKey({
    key: privatePem,
    passphrase: passphrase || undefined
  });

  // RSA-OAEP(SHA-256) decrypt of the one-time AES key.
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    Buffer.from(encrypted_aes_key, "base64")
  );

  const iv = Buffer.from(initial_vector, "base64");
  const flowData = Buffer.from(encrypted_flow_data, "base64");
  const ciphertext = flowData.subarray(0, flowData.length - TAG_LENGTH);
  const authTag = flowData.subarray(flowData.length - TAG_LENGTH);

  // Cipher width follows the AES key length (Meta uses AES-128-GCM).
  const algorithm = `aes-${aesKey.length * 8}-gcm`;
  const decipher = crypto.createDecipheriv(algorithm, aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  return {
    decryptedBody: JSON.parse(decrypted.toString("utf-8")),
    aesKey,
    iv
  };
}

export function encryptResponse(response, aesKey, iv) {
  // Response IV is the request IV with every bit flipped.
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    flippedIv[i] = ~iv[i];
  }

  const algorithm = `aes-${aesKey.length * 8}-gcm`;
  const cipher = crypto.createCipheriv(algorithm, aesKey, flippedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(response), "utf-8"),
    cipher.final(),
    cipher.getAuthTag()
  ]);

  // Meta expects the raw base64 ciphertext as the plain-text response body.
  return encrypted.toString("base64");
}
