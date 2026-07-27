# Status

Last updated: July 27, 2026 · Repo `E:\MyFiles\Rahman\WhatsApp` →
https://github.com/abdulrashed/whatsapp-test-webhook → Vercel
`whatsapp-test-webhook` (auto-deploy from `main`).

## Built and deployed

- **Menu** — one interactive message: Book a Slot / My Bookings / Chat with Venue.
- **Sessions & venues** — `src/session.js` (`wa_sessions`), `src/venues.js`
  (`wa_numbers/{phone_number_id}` → venue). Human-handoff silence via
  `smb_message_echoes`. All Firestore ops fail open.
- **Booking data layer** — `src/booking.js`: availability, pricing, holds,
  `processing` bookings. No finance/coupon logic — the PHP webhook owns money.
- **Flow** — `src/flow-crypto.js`, `src/flow-core.js` (screen router),
  `api/flow.js`, `flows/book-slot.json`. Sport → date → court → time → duration
  → summary, then a Razorpay Pay Now link (`src/payments.js`).
- **Payment confirmation** — `api/payment-notify.js`, HMAC-verified, deduped via
  `wa_confirmation_sent_at`. Needs the PHP call added (FLOW_SETUP.md §7).

Verified against live Firestore `turf-app-930c5`.

## Remaining — Meta side (only the account owner can do these)

1. Create + publish the Flow from `flows/book-slot.json`; set `FLOW_ID`.
2. Generate the RSA keypair, upload the public key, set `FLOW_PRIVATE_KEY` /
   `FLOW_KEY_PASSPHRASE`; point the Flow endpoint at `/flow`.
3. Seed `wa_numbers/{phone_number_id}` with the venue.
4. Confirm `WHATSAPP_TOKEN` in Vercel Production is valid and permanent.

See [FLOW_SETUP.md](FLOW_SETUP.md) for the exact commands.

## Not built

- **My Bookings** UI (`fetchUpcomingBookings` exists, no screens).
- **`booking_confirmed` template** — only needed for sends >24h after the
  customer's last message (reminders, late captures).
- **Stale-booking sweep** — a booking whose payment never captures stays
  `processing` forever.
- **PHP edit** in the GameOn backend: `v2_webhook_live.php` → POST
  `/payment-notify` after capture. The only external change still required.
- **Coexistence onboarding** for the real venue number (test number is a plain
  Cloud API number).

## Known gotchas

- Changing `flows/book-slot.json` needs **both** a `git push` (endpoint code) and
  a re-paste + re-publish in Flow Builder. A mismatch shows in WhatsApp as
  "Something went wrong".
- A Flow screen may never route to itself — Meta rejects it as a routing loop.
- A `ChipsSelector` needs 2–20 options, at runtime as well as in preview.
- One invalid component blocks every action on its screen, even when hidden.
