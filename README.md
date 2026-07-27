# WhatsApp Booking Webhook

WhatsApp Cloud API webhook + booking Flow for GameOn venues (first: Legend Arena).
Node/Express locally, Vercel serverless in production. Reads/writes the existing
GameOn Firestore (`turf-app-930c5`); money stays with the PHP Razorpay webhook.

- Setup on Meta's side: [FLOW_SETUP.md](FLOW_SETUP.md)
- Current status: [PROGRESS.md](PROGRESS.md)

## Routes

| Route | Purpose |
|---|---|
| `/health` | Liveness + config check |
| `/webhook` | Meta verification (GET) and inbound messages (POST) |
| `/flow` | Encrypted Flow data-exchange endpoint |
| `/send-template` | Manual template send (testing) |
| `/payment-notify` | HMAC-signed call from `v2_webhook_live.php` → booking confirmation |

## Environment

Same keys locally (`.env`) and in Vercel. See [.env.example](.env.example) for the
full annotated list; the required ones:

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
buttons: **Book a Slot**, **My Bookings**, **Chat with Venue**. Watch Vercel →
Deployments → Functions → Logs.
