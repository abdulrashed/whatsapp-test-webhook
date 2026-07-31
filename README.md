# WhatsApp Booking Webhook

WhatsApp Cloud API webhook + booking Flow for GameOn venues (first: Legends
Arena). Node/Express locally, Vercel serverless in production. Reads/writes the
existing GameOn Firestore (`turf-app-930c5`); money stays with the PHP Razorpay
webhook.

- Setup on Meta's side: [FLOW_SETUP.md](docs/FLOW_SETUP.md)
- Current status: [PROGRESS.md](PROGRESS.md)

## What this does

Five jobs, in the order a customer hits them.

**1. Answer the chat and show a menu.** Any inbound text replies with one
interactive message — *Book a Slot* / *My Bookings* / *Chat with Venue*
([src/whatsapp.js:44](src/whatsapp.js:44)). Which venue's name appears is
resolved from the `phone_number_id` that received the message, so one deployment
serves many venues ([src/venues.js](src/venues.js)).

**1b. List upcoming bookings.** *My Bookings* replies with the customer's
confirmed future bookings, soonest first, across every venue they have booked —
not just the one they are messaging. Only `booking_type: "online"` counts, so an
abandoned checkout never appears ([src/booking.js](src/booking.js)).

**2. Step back when a human takes over.** *Chat with Venue* puts the
conversation in `human` mode and the bot goes quiet. Under coexistence, an owner
replying from the WhatsApp Business app arrives as an `smb_message_echoes` event
and triggers the same silence. It expires after `HUMAN_MODE_TTL_MS`, or the
moment the customer types `menu` ([src/session.js](src/session.js)).

**3. Run the booking Flow.** *Book a Slot* sends a Flow message; WhatsApp then
calls `/flow` for every screen. The endpoint is the screen router — it holds no
session, because each screen's footer posts the running selection back and
`flow_token` (`v1|<venueId>|<waId>`) carries identity
([src/flow-core.js](src/flow-core.js)):

```text
SPORT → DATE → COURT → TIME → DURATION → SUMMARY
```

Every screen is a `ChipsSelector` reading live Firestore — real courts, the
venue's booking window, genuinely free start times, and only those durations
whose whole span is still open, each priced. A screen with nothing to choose
(one sport, one court, one free slot) is skipped rather than shown. Requests are
RSA+AES encrypted both ways ([src/flow-crypto.js](src/flow-crypto.js)).

**4. Hold the slot and collect payment.** The submitted Flow comes back as an
`nfm_reply`. Availability is re-checked (the Flow may have sat open), a
5-minute hold goes into `block_concurrent`, a `processing` booking is written,
a Razorpay order is created through the existing PHP endpoint, and a *Pay Now*
CTA opens the hosted checkout page
([src/webhook-core.js:280](src/webhook-core.js:280)).

**5. Confirm after capture.** `v2_webhook_live.php` stays the single authority
on money; after it captures it POSTs `/payment-notify` (HMAC-signed), and this
repo — which holds the WhatsApp token — sends the confirmation. Deduped via
`wa_confirmation_sent_at` ([api/payment-notify.js](api/payment-notify.js)).

Deliberately **not** here: finance sync, coupons, refunds, capture. The WhatsApp
path only ever writes a `processing` booking; the PHP webhook owns the rest.

## Routes

| Route | Purpose |
|---|---|
| `/health` | Liveness + config check |
| `/webhook` | Meta verification (GET) and inbound messages (POST) |
| `/flow` | Encrypted Flow data-exchange endpoint |
| `/send-template` | Manual template send (testing) |
| `/payment-notify` | HMAC-signed call from `v2_webhook_live.php` → booking confirmation |

## Firestore

Shared with the GameOn app (`turf-app-930c5`). Read: `venue_details`,
`courts_details`, `weekly_slots`, `daily_slots`, `users`. Read+write:
`bookings`, `block_concurrent`. Owned by this repo: `wa_sessions` (bot/human
mode per customer).

The venue↔number map is a `phone_number_id` field on the venue's own
`venue_details` doc — there is no separate mapping collection. Seed it with
[scripts/set-venue-phone-number.js](scripts/set-venue-phone-number.js).

## Environment

Same keys locally (`.env`) and in Vercel. See [.env.example](.env.example) for
the full annotated list; the required ones:

```env
GRAPH_API_VERSION=v25.0
WHATSAPP_TOKEN=            # permanent token; temp ones expire in 24h (OAuthException 190)
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_WABA_ID=
WHATSAPP_VERIFY_TOKEN=     # any random string, mirrored in Meta
META_APP_SECRET=
VALIDATE_META_SIGNATURE=true
FLOW_ID=                   # from Flow Builder
FLOW_PRIVATE_KEY=          # PEM as one line with \n escapes
FLOW_KEY_PASSPHRASE=
PAYMENT_NOTIFY_SECRET=     # shared with v2_webhook_live.php
```

Never commit real values. `.env` is gitignored.

## Run locally

```powershell
npm install; npm run dev
```

Expose port 3000 with a tunnel, then point Meta at `https://<tunnel>/webhook`.

## Deploy

Vercel project `whatsapp-test-webhook`, auto-deploys from `main`
(https://whatsapp-test-webhook.vercel.app). Framework preset **Other**, no build
command, no output directory. Add the env vars above, then **redeploy** — env
changes don't apply to existing deployments.

In Meta → WhatsApp → Configuration:

```text
Callback URL:  https://whatsapp-test-webhook.vercel.app/webhook
Verify token:  same as WHATSAPP_VERIFY_TOKEN
Fields:        messages (+ smb_message_echoes on coexistence numbers)
```

## Test

Message the number `Hi` from an allowed recipient. Expect a greeting plus three
buttons, then walk *Book a Slot* through to the Pay Now link. Watch Vercel →
Deployments → Functions → Logs.
