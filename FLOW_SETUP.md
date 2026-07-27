# Meta setup for the booking Flow

The code is built and deployed; these are the Meta-side steps only the account
owner can do. Do them on the **test number** first — step 3 ties a key to a
number. Base URL: `https://whatsapp-test-webhook.vercel.app`

Prerequisites: the webhook already replies with the menu, you know the
**Phone Number ID**, `WHATSAPP_TOKEN` in Vercel is valid, and `openssl` is
available (Git Bash has it).

## 1. Create the Flow

WhatsApp Manager → **Flows** → **Create Flow**.

- Name `GameOn Book Slot`, category **Appointment booking**.
- Start from scratch → **Endpoint** (data exchange), not a static template.
- Open the `{ }` JSON editor and paste all of [`flows/book-slot.json`](flows/book-slot.json).
- Endpoint URI: `https://whatsapp-test-webhook.vercel.app/flow`
- Leave it a **draft** until the key is uploaded, then publish. Note the **Flow ID**.

## 2. Generate the RSA keypair

```bash
openssl genrsa -aes256 -passout pass:CHANGE_ME -out flow_private.pem 2048
openssl rsa -in flow_private.pem -passin pass:CHANGE_ME -pubout -out flow_public.pem
```

`flow_private.pem` is secret — never commit it.

## 3. Upload the public key

```bash
curl -X POST "https://graph.facebook.com/v25.0/PHONE_NUMBER_ID/whatsapp_business_encryption" \
  -H "Authorization: Bearer TOKEN" \
  --data-urlencode "business_public_key=$(cat flow_public.pem)"
```

Verify with the same URL via `GET`; expect `signature_status: VALID` (may take a
minute).

## 4. Set the Vercel env vars

Settings → Environment Variables → add `FLOW_ID`, `FLOW_PRIVATE_KEY`,
`FLOW_KEY_PASSPHRASE`, `VENUE_NAME`, then **redeploy**.

`FLOW_PRIVATE_KEY` must be one line with `\n` escapes:

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0;}' flow_private.pem
```

## 5. Map the number to a venue

`book_slot` resolves the venue from Firestore:

```text
wa_numbers/{PHONE_NUMBER_ID} = { venueId: "<venue_details doc id>", venueName: "Legend Arena" }
```

Until this exists, "Book a Slot" replies "not set up yet" by design. Seed it from
the Firebase console for `turf-app-930c5`, or ask the developer with the Phone
Number ID + venue id.

## 6. Test

1. **Health check** in Flow Builder (⋯ → Health check) — the endpoint must return
   `{"data":{"status":"active"}}`. Green means encryption works both ways.
2. Message the number `Hi` → **Book a Slot** → the SPORT screen opens. A draft
   Flow opens only for its creator.
3. Walk sport → date → court → time → duration → summary → **Confirm & Pay**.
4. The Pay Now link hits **live** Razorpay — real money. Use a ₹1 slot.
5. Watch Vercel → Deployments → Functions → Logs throughout.

| Symptom | Likely cause |
|---|---|
| Health check fails, "Decryption failed" (421) | Public key not uploaded/mismatched, or wrong `FLOW_KEY_PASSPHRASE` |
| "Signature verification failed" (432) | Wrong `META_APP_SECRET` / `VALIDATE_META_SIGNATURE` |
| "Book a Slot" says not set up | `FLOW_ID` missing or `wa_numbers` not seeded |
| "Something went wrong" in the Flow | Flow JSON in Builder is out of sync with the deployed endpoint — re-push **and** re-publish |
| Empty screen | No availability (INFO screen) or a Firestore read failed — check `/flow` logs |
| No reply at all | Expired `WHATSAPP_TOKEN` (`OAuthException 190`) |
| Pay link errors | `CHECKOUT_BASE_URL` / `CREATE_ORDER_URL` wrong, or the PHP backend rejected the order |

## 7. Payment confirmation (`/payment-notify`)

Razorpay's webhook `v2_webhook_live.php` stays the single source of truth for
money. It just fires a notification here so this repo — which already holds the
WhatsApp token and the venue↔number map — sends the confirmation.

After the capture commits, add to `v2_webhook_live.php`:

```php
$body = json_encode(["order_id" => $orderId, "status" => "captured", "payment_id" => $paymentId]);
$sig  = "sha256=" . hash_hmac("sha256", $body, $PAYMENT_NOTIFY_SECRET);
$ch = curl_init("https://whatsapp-test-webhook.vercel.app/payment-notify");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ["Content-Type: application/json", "x-gameon-signature: $sig"],
  CURLOPT_POSTFIELDS => $body,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 5,
]);
curl_exec($ch); // ignore result — must never fail the payment
curl_close($ch);
```

Set the same `PAYMENT_NOTIFY_SECRET` on both sides. The endpoint returns `200` on
success and on any internal skip (booking not found, not a WhatsApp booking,
already sent) so Razorpay never retries; `401` for a bad signature, `400` for
malformed input. The message is free-form — the 24-hour service window is open
seconds after the customer messaged, so no template approval is needed.

**Payment method** is chosen on the checkout page, not in the Flow — a Flow
cannot launch GPay/PhonePe (no intent action; CTA buttons take http/https only).
The checkout URL just carries `prefer=upi` and `v2_checkout_live.html` surfaces
the UPI apps itself. This PHP edit is the only external change still required.

What this guide does **not** cover is listed under "Not built" in
[PROGRESS.md](PROGRESS.md).
