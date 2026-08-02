# Status

Last updated: July 28, 2026 · Repo `E:\MyFiles\Rahman\WhatsApp` →
https://github.com/abdulrashed/whatsapp-test-webhook → Vercel
`whatsapp-test-webhook` (auto-deploy from `main`).

**The booking Flow is live and working end to end on the test number**: menu →
Book a Slot → sport → date → court → time → duration → summary → Pay Now.

## Working

- **Menu** — one interactive message: Book a Slot / My Bookings / Chat with
  Venue.
- **Sessions & venues** — `src/session.js` (`wa_sessions`), `src/venues.js`
  (venue resolved from `venue_details.phone_number_id`). Human-handoff silence
  via `smb_message_echoes`. All Firestore ops fail open.
- **Booking data layer** — `src/booking.js`: availability, pricing, holds,
  `processing` bookings. No finance/coupon logic — the PHP webhook owns money.
- **Flow** — `src/flow-crypto.js`, `src/flow-core.js` (screen router),
  `api/flow.js`, `flows/book-slot.json`. Encryption verified both ways (Flow
  Builder health check green); Flow created and published; the RSA keypair is set
  in Vercel (global), and the venue's `phone_number_id`, `wa_access_token` and
  `wa_flow_id` are seeded on its `venue_details` doc (no global send creds).
- **Payment** — Razorpay order via the existing PHP endpoint, Pay Now CTA to the
  hosted checkout page (`src/payments.js`).
- **My Bookings** — `fetchUpcomingBookings` + `buildUpcomingBookingsText`, soonest
  first, across every venue the customer has booked. Verified against real
  `turf-app-930c5` bookings.

Verified against live Firestore `turf-app-930c5`.

## Remaining

- **PHP edit** in the GameOn backend: `v2_webhook_live.php` → POST
  `/payment-notify` after capture (docs/FLOW_SETUP.md §7). Until this lands the
  booking is paid but no WhatsApp confirmation goes out. The only external
  change still required.
- **Stale-booking sweep** — a booking whose payment never captures stays
  `processing` forever.
- **`booking_confirmed` template** — only needed for sends >24h after the
  customer's last message (reminders, late captures).
- **Coexistence onboarding** for the real venue number (the test number is a
  plain Cloud API number, and the `smb_message_echoes` payload shape is still
  unverified against a live coexistence account).

## Known gotchas

- Changing `flows/book-slot.json` needs **both** a `git push` (endpoint code) and
  a re-paste + re-publish in Flow Builder. A mismatch shows in WhatsApp as
  "Something went wrong".
- A Flow screen may never route to itself — Meta rejects it as a routing loop.
- One invalid component blocks every action on its screen, even when hidden.
- Every selection is a `ChipsSelector`, and navigation stays on a `Next` footer.
  **Do not try `on-select-action` again.** It has been attempted twice; the
  second time (`105a87d`, reverted) a sport chip tap never reached the date
  screen at all, with or without `required` set. Whatever the cause, one-tap
  chip navigation does not work here — a footer does.
- A `ChipsSelector` needs 2–20 options at runtime, not just in preview. Hence
  the endpoint skipping a screen whose list has one entry (single-sport venue,
  single court, one free slot), capping at 20, and padding hidden groups.
- Chips submit an **array** even under `max-selected-items: 1` — unwrap before
  the value goes downstream.
- Chips-per-row is not settable; a wide label is what puts a duration on its own
  row. Shortening those titles silently repacks them two-up.
- Firestore has a composite index on `bookings(user_id, date)` but **not** one
  covering a `date >=` range alongside it. My Bookings therefore filters to
  upcoming in memory; adding a server-side range filter needs a new index, and a
  missing index shows up as an empty list rather than an error.
- Single-court venues store `court_name` identical to `venue_name`, so booking
  copy has to collapse the two rather than print "Legends Arena · LEGENDS ARENA".
- DATE splits its window across two groups, and only one may be `required` — a
  required group blocks the footer for anyone choosing from the other, so a
  split window leaves both optional and lets the endpoint reject an empty
  submit.
