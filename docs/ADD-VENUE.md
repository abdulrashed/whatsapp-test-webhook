# Onboard a new venue (GameOn operator runbook)

The **internal** checklist for bringing a new turf live, run **once per venue by
GameOn** after the owner finishes their Meta setup ([`ONBOARDING.md`](ONBOARDING.md)).
One deployment serves every venue — messages are routed by the `phone_number_id`
they arrive on, and each send is authorized by that venue's own token
(`src/venues.js` → `resolveAccessToken`). So onboarding is almost entirely
**data + Meta config**, not code.

This complements the deep-dives: encryption/Flow mechanics live in
[`FLOW_SETUP.md`](FLOW_SETUP.md); this file is the ordered sequence and the
**per-venue** (multi-WABA) specifics FLOW_SETUP predates.

Base URL: `https://whatsapp-test-webhook.vercel.app`

## Model check — does this venue have its OWN portfolio?

| Situation | Token needed? | Flow/template needed? |
|---|---|---|
| Number under **GameOn's own WABA** (the one whose token is in Vercel `WHATSAPP_TOKEN`) | No — global token is the fallback | Can reuse the Flow already on that WABA |
| Number under the **venue's own portfolio/WABA** (the normal case) | **Yes — its own `wa_access_token`** | **Yes — its own Flow + template on that WABA** |

Everything below is the **own-portfolio** path. A token scopes to exactly one
WABA, so a venue in its own portfolio cannot use the global token.

## Prerequisites (from the owner)

Confirm the owner has, per [`ONBOARDING.md`](ONBOARDING.md):

- Shared their **WhatsApp Account (WABA)** with GameOn's Business ID (Partners → Add).
- Sent you the **Phone Number ID** and the **WABA ID**.
- Set a **profile picture** on the number (must be done before coexistence onboarding).

## 1. Generate the venue's access token

Under **GameOn's** Business Manager (keeps every token in one place):

1. **Business Settings → Users → System Users** → your integration system user.
2. **Assign assets** → **WhatsApp accounts** → the venue's WABA → **Full control**;
   also assign **Apps** → your app → Full control.
3. **Generate new token** → App = your app → **Expiration: Never** →
   scopes **`whatsapp_business_messaging`** + **`whatsapp_business_management`**.
4. **Copy it now** — shown once. This string is the venue's `wa_access_token`.

Detailed click-path and the alternative "owner generates it" flow are in the
project notes; the above is the recommended path.

## 2. Smoke-test the token (before anything depends on it)

```bash
curl "https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>?fields=display_phone_number" \
  -H "Authorization: Bearer <TOKEN>"
```

Expect the number back. `190` = wrong/expired token or the WABA isn't assigned to
the system user. `200`/permissions error = missing the two scopes.

## 3. Subscribe the WABA to the app

Without this, the venue's inbound messages never reach the webhook.

```bash
curl -X POST "https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <TOKEN>"
```

Verify with the same URL via `GET` — the app should be listed.

## 4. Upload the Flow encryption public key to this number

The RSA **keypair can be reused across all venues** — the `/flow` endpoint holds
one private key (`FLOW_PRIVATE_KEY`), so upload the **same** public key to each
number. Generate once ([`FLOW_SETUP.md` §2](FLOW_SETUP.md)), then per number:

```bash
curl -X POST "https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/whatsapp_business_encryption" \
  -H "Authorization: Bearer <TOKEN>" \
  --data-urlencode "business_public_key=$(cat flow_public.pem)"
```

`GET` the same URL until `signature_status: VALID`.

## 5. Create the Flow on this WABA

Flows live **on the WABA**, so each own-portfolio venue needs its own. Follow
[`FLOW_SETUP.md` §1](FLOW_SETUP.md): create `GameOn Book Slot`, paste
[`flows/book-slot.json`](../flows/book-slot.json), endpoint
`https://whatsapp-test-webhook.vercel.app/flow`, publish, and **note the Flow ID**
— you'll seed it in §7 as `wa_flow_id`.

The code resolves it per venue: `resolveVenue` returns the doc's `wa_flow_id` and
`respondToButton` prefers it, falling back to the global `FLOW_ID` env only for a
number under GameOn's own WABA. So an own-portfolio venue **must** carry
`wa_flow_id`, exactly like its token.

## 6. Provision the `booking_confirmed` template on this WABA

Templates also live on the WABA. Create it (per-WABA, needs that WABA's token/id):

```bash
node scripts/create-template.js --write
```

Then **wait for Meta approval** before any confirmation send will work. If it was
ever created manually with numbered `{{1}}` vars or `en_US`, match
`sendBookingTemplate` in `src/whatsapp.js` to that shape/language.

## 7. Seed the venue doc

Stamp the number, its token, and its Flow id onto the venue's `venue_details`
doc. The helper prints the match first and only writes with `--write`:

```bash
# dry run — confirm the right venue
node scripts/set-venue-phone-number.js "<name substring>" <PHONE_NUMBER_ID> --token <TOKEN> --flow-id <FLOW_ID>
# commit it
node scripts/set-venue-phone-number.js "<name substring>" <PHONE_NUMBER_ID> --token <TOKEN> --flow-id <FLOW_ID> --write
```

Omit `--token` / `--flow-id` **only** for a number under GameOn's own WABA (it
falls back to the global `WHATSAPP_TOKEN` / `FLOW_ID`). For an own-portfolio venue
both are required.

## 8. Verify end to end

Per [`FLOW_SETUP.md` §6](FLOW_SETUP.md):

1. **Health check** in Flow Builder (⋯ → Health check) → `{"data":{"status":"active"}}`.
2. Message the number `Hi` → the menu greets with **this venue's** name.
3. **Book a Slot** → walk sport → date → court → time → duration → summary.
4. **Confirm & Pay** hits **live** Razorpay — use a ₹1 slot.
5. Watch Vercel → Functions → Logs; a `190` there means the wrong token resolved.

## 9. Payment confirmation (one-time, already global)

`/payment-notify` and the `v2_webhook_live.php` curl call are shared across all
venues — set up **once**, not per venue. See [`FLOW_SETUP.md` §7](FLOW_SETUP.md).
The confirmation send picks the venue's token automatically from
`booking.wa_phone_number_id`.

## Quick reference — what's per-venue vs shared

| Item | Per-venue | Shared |
|---|---|---|
| `phone_number_id` (venue doc) | ✅ | |
| `wa_access_token` (venue doc) | ✅ (own portfolio) | falls back to global |
| WABA → app subscription | ✅ | |
| Flow (+ Flow ID → `wa_flow_id`) | ✅ | falls back to global `FLOW_ID` |
| `booking_confirmed` template | ✅ | |
| RSA Flow keypair | | ✅ reuse, upload public key per number |
| `/payment-notify` + PHP curl | | ✅ set once |
| Webhook URL + verify token | | ✅ one app-level webhook |
