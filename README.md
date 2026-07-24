# WhatsApp Test Webhook

Standalone Node.js Express webhook for testing Meta WhatsApp Cloud API with the Meta test number.

## Current Meta Values

- App: `Arenza`
- Test WhatsApp number: `+1 (555) 666-7628`
- Phone Number ID: `1107576985771392`
- WhatsApp Business Account ID: `2850166098660100`

## Local Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env`.

3. Paste your generated access token into:

   ```env
   WHATSAPP_TOKEN=
   ```

4. Add your Meta app secret:

   ```env
   META_APP_SECRET=
   ```

5. Choose your own webhook verify token:

   ```env
   WHATSAPP_VERIFY_TOKEN=some_random_private_text
   ```

6. Start the server:

   ```powershell
   npm run dev
   ```

7. For local tunnel testing, expose port `3000` with a tunnel tool.

8. In Meta Developer App, configure the webhook using the public HTTPS URL:

   ```text
   Callback URL: https://your-public-url/webhook
   Verify token: same value as WHATSAPP_VERIFY_TOKEN
   Webhook field: messages
   ```

## Vercel Deployment

This project is ready for Vercel. It exposes these serverless-compatible routes:

```text
/health
/webhook
/send-template
```

Set these Vercel Environment Variables before deploying:

```env
GRAPH_API_VERSION=v25.0
WHATSAPP_TOKEN=your_generated_access_token
WHATSAPP_PHONE_NUMBER_ID=1107576985771392
WHATSAPP_WABA_ID=2850166098660100
WHATSAPP_VERIFY_TOKEN=your_private_verify_token
META_APP_SECRET=your_meta_app_secret
VALIDATE_META_SIGNATURE=true
```

After deployment, use this in Meta:

```text
Callback URL: https://your-vercel-project.vercel.app/webhook
Verify token: same value as WHATSAPP_VERIFY_TOKEN
Webhook field: messages
```

For GitHub import and Vercel dashboard steps, see `DEPLOYMENT.md`.

## Test

Send `Hi` from your verified personal WhatsApp recipient to the Meta test number.

Expected result:

1. The server logs the inbound message.
2. WhatsApp receives a welcome text.
3. WhatsApp receives buttons: `Book Turf`, `View Slots`, `Contact Staff`.

This project is intentionally separate from the booking app. Booking availability, holds, and payment links should be connected only after this basic webhook flow works.
