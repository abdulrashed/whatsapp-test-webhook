# WhatsApp Booking Flow — Meta Setup Guide

Everything in this repo (menu, sessions, the Flow endpoint, screens, payment
link) is built and deployed. This guide covers the **Meta-side setup** that
only you can do, to make the booking Flow work on a real phone.

Work top to bottom. Steps 2 and 3 are irreversible-ish (you upload a key tied
to a number), so do them on the **test number** first.

Deployed base URL used throughout: `https://whatsapp-test-webhook.vercel.app`

---

## 0. Prerequisites checklist

- [ ] The test number's webhook is already working (you've seen the menu reply).
- [ ] You know the test number's **Phone Number ID** (Meta → WhatsApp → API Setup).
- [ ] The production **WHATSAPP_TOKEN** in Vercel is valid (a permanent token is best; temporary ones expire in 24h and cause `OAuthException 190`).
- [ ] `openssl` is available (Git Bash on Windows has it).

---

## 1. Create the Flow in Meta

1. Go to **WhatsApp Manager → Flows** (business.facebook.com → WhatsApp Manager, left sidebar **Flows**).
2. Click **Create Flow**.
   - Name: `GameOn Book Slot`
   - Categories: tick **Appointment booking** (or **Other**).
   - Template: **Start from scratch** → choose **Endpoint** (data exchange), not a static template.
3. In the Flow Builder, switch to the **`{ }` JSON editor** (top right toggle).
4. Delete the sample JSON and **paste the entire contents of** [`flows/book-slot.json`](flows/book-slot.json).
5. The preview should render the **SPORT** screen with a sample "Football" option. If the editor shows validation errors, fix them here (it points at the exact line).
6. Set the **Endpoint URI** for the Flow to:
   ```
   https://whatsapp-test-webhook.vercel.app/flow
   ```
   (Flow Builder → the endpoint field, sometimes under the **⚙ / Endpoint** section.)
7. **Don't publish yet** — you need the encryption key uploaded first (Step 2/3), or the health check will fail. Leave it as a **draft**; note the **Flow ID** shown in the URL or the Flow's detail panel.

> You can send and test a **draft** Flow to yourself before publishing (see Step 6).

---

## 2. Generate the RSA key pair

Meta encrypts every Flow request with your public key; your endpoint decrypts
with the private key. Run in Git Bash (pick your own passphrase):

```bash
# Private key (encrypted with a passphrase)
openssl genrsa -aes256 -passout pass:CHANGE_ME_PASSPHRASE -out flow_private.pem 2048

# Public key (to upload to Meta)
openssl rsa -in flow_private.pem -passin pass:CHANGE_ME_PASSPHRASE -pubout -out flow_public.pem
```

You now have `flow_private.pem` (secret — never commit) and `flow_public.pem`.

---

## 3. Upload the public key to Meta

Replace `PHONE_NUMBER_ID` and `TOKEN`, then run:

```bash
curl -X POST \
  "https://graph.facebook.com/v25.0/PHONE_NUMBER_ID/whatsapp_business_encryption" \
  -H "Authorization: Bearer TOKEN" \
  --data-urlencode "business_public_key=$(cat flow_public.pem)"
```

Verify it registered:

```bash
curl "https://graph.facebook.com/v25.0/PHONE_NUMBER_ID/whatsapp_business_encryption" \
  -H "Authorization: Bearer TOKEN"
```

You should see your public key and `signature_status: VALID` (may take a minute).

---

## 4. Set the Vercel environment variables

Vercel → project **whatsapp-test-webhook** → **Settings → Environment Variables**.
Add these (Production, and Preview if you use it):

| Key | Value |
|---|---|
| `FLOW_ID` | The Flow ID from Step 1 |
| `FLOW_PRIVATE_KEY` | Contents of `flow_private.pem`, as ONE line with `\n` between lines (see below) |
| `FLOW_KEY_PASSPHRASE` | The passphrase you chose in Step 2 |
| `VENUE_NAME` | `Legend Arena` (fallback name; optional once Step 5 is done) |

To turn the PEM into a single `\n`-escaped line (Git Bash):

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0;}' flow_private.pem
```

Copy that output as the `FLOW_PRIVATE_KEY` value. (The app un-escapes `\n` back
to real newlines at runtime.)

**Redeploy** after saving (Deployments → ⋯ → Redeploy) — env changes need it.

Confirm the endpoint sees the key:
```bash
curl -s https://whatsapp-test-webhook.vercel.app/health
```
(Health won't show FLOW status, but a 200 confirms the deploy is up.)

---

## 5. Point the number at a venue (seed `wa_numbers`)

"Book a Slot" needs to know which GameOn venue this number serves. This is a
Firestore doc keyed by the **Phone Number ID**:

```
wa_numbers/{PHONE_NUMBER_ID} = {
  venueId:   "<venue_details doc id>",
  venueName: "Legend Arena"
}
```

Ask the developer (me) to seed this — I just need the **Phone Number ID** and
the **venue id** — or set it from any Firebase console with access to
`turf-app-930c5`. Until this exists, "Book a Slot" replies with a
"not set up yet" message (by design, so nothing breaks).

---

## 6. Test

**a. Endpoint health (ping).** In Flow Builder, use the **⋯ → Health check** (or
"Test" on the endpoint). It sends an encrypted `ping`; the endpoint must return
`{"data":{"status":"active"}}`. Green = decryption + response encryption work.

**b. Send the Flow to yourself.** From WhatsApp, message the number `Hi`, tap
**Book a Slot**. The Flow should open to the SPORT screen. (If the Flow is still
a draft, Meta lets the Flow's creator open it; publish it for everyone else.)

**c. Walk the screens.** Sport → date → court → time → duration → summary. Each
should show live availability. Tap **Confirm & Pay**.

**d. Payment.** You should receive a **Pay Now** message with a checkout link.
⚠️ This hits the **live** Razorpay endpoint — real money. Use a ₹1 test slot or
a test order endpoint if you have one.

**e. Watch Vercel logs** (Deployments → Functions → Logs) during all of the
above. `/flow` requests and any decryption/handler errors show there.

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Health check fails, `/flow` logs "Decryption failed" (421) | Public key not uploaded / mismatched, or wrong `FLOW_KEY_PASSPHRASE`. Re-run Step 3, re-check the env var. |
| Health check fails, logs "Signature verification failed" (432) | `META_APP_SECRET` wrong or `VALIDATE_META_SIGNATURE` mismatch. |
| "Book a Slot" replies "not set up yet" | `FLOW_ID` missing, or `wa_numbers` not seeded (Step 4/5). |
| Flow opens but a screen is empty / errors | The endpoint returned an INFO screen (no availability) or a Firestore read failed — check `/flow` logs. |
| No reply at all to any message | Expired `WHATSAPP_TOKEN` (`OAuthException 190`) — regenerate. |
| Pay link 404 / error | `CHECKOUT_BASE_URL` / `CREATE_ORDER_URL` wrong, or the PHP backend rejected the order. |

---

---

## 8. Payment confirmation on WhatsApp (`/payment-notify`)

Payment success is owned by the **Razorpay webhook** `v2_webhook_live.php`
(finance, coupons, capture). It stays the single source of truth for money.
The WhatsApp confirmation is a **separate** concern handled by this repo, so the
PHP side does not need a second copy of the WhatsApp token or the venue → number
mapping.

**Flow of a paid booking:**

1. The customer pays on the checkout page → Razorpay captures → calls
   `v2_webhook_live.php` (unchanged).
2. After it commits the capture, `v2_webhook_live.php` makes a fire-and-forget
   `POST` to `https://<this-app>/payment-notify`.
3. `/payment-notify` looks up the booking by `order_id`, confirms it is a
   `source: "whatsapp"` booking, and sends the confirmation message from the
   correct venue number (`wa_phone_number_id` stored on the booking). It marks
   `wa_confirmation_sent_at` so a retried webhook can't double-send.

Because the payment lands seconds after the customer messaged you, the 24-hour
customer-service window is open and the confirmation is a **free-form** message
— **no Meta template approval needed**. (A `booking_confirmed` template is only
required later, for reminders or captures that arrive after 24h.)

**Set `PAYMENT_NOTIFY_SECRET`** (see `.env.example`) to a long random value in
this app's Vercel env **and** in the PHP config.

**Request contract:**

```
POST /payment-notify
Content-Type: application/json
x-gameon-signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with PAYMENT_NOTIFY_SECRET>

{ "order_id": "order_XXXX", "status": "captured", "payment_id": "pay_XXXX" }
```

PHP side (add to `v2_webhook_live.php` after the capture is committed):

```php
$body = json_encode(["order_id" => $orderId, "status" => "captured", "payment_id" => $paymentId]);
$sig  = "sha256=" . hash_hmac("sha256", $body, $PAYMENT_NOTIFY_SECRET);
$ch = curl_init("https://<this-app>/payment-notify");
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

The endpoint returns `200 {ok:true,...}` on success and on any *internal* skip
(booking not found, not a WhatsApp booking, already sent) so Razorpay never
retries for a messaging problem. It returns `401` only for a bad/missing
signature and `400` for malformed input.

**Payment method** is chosen on the checkout page, not in the Flow. A Flow has
no way to launch GPay/PhonePe (there is no intent action, and WhatsApp CTA
buttons only accept http/https), so the checkout URL just carries `prefer=upi`
and `v2_checkout_live.html` surfaces the UPI apps itself.

---

## What is NOT set up by this guide

- **My Bookings** list (data function exists; UI not built).
- **`booking_confirmed` template** — only needed for confirmations sent >24h
  after the last customer message (reminders, delayed captures). The immediate
  post-payment confirmation is handled free-form by `/payment-notify` (§8).
- **Stale-booking sweep** — a booking whose payment never captures stays
  `processing`. A cron/lazy sweep to cancel it and notify the customer is not
  built.
- **`v2_webhook_live.php` edit** — the external PHP change above (POST to
  `/payment-notify` after capture) lives in the GameOn PHP backend, not this
  repo. It is the only PHP change still required.
- **Coexistence** (Business app + API on the same number) — only relevant for
  the real Legend Arena number, not this test number. See the project plan.
