# Get your turf on WhatsApp booking — Meta setup

Customer-facing guide for a **turf owner** setting up the Meta side so GameOn can
run booking on their WhatsApp number. Done **once** per turf. The polished,
printable version is [`GameOn-Turf-WhatsApp-Setup-Guide.docx`](GameOn-Turf-WhatsApp-Setup-Guide.docx)
/ [`.pdf`](GameOn-Turf-WhatsApp-Setup-Guide.pdf) (has the *Fig 1–5* screenshot
frames). The technical wiring on GameOn's side is [`FLOW_SETUP.md`](FLOW_SETUP.md)
— nothing the owner touches.

Pick **Guide 1** if GameOn sent a "Connect WhatsApp" link (5 minutes). Use
**Guide 2** only when setting everything up by hand.

## Before you start — have these ready

- A **personal Facebook account** you control (you'll be the admin behind the business).
- Your **business name** exactly as you want it shown to customers.
- A **business email** address Meta can contact you on.
- The **turf's mobile number** that will be used for WhatsApp.
- **Proof of the business** — any ONE showing your legal name + address: GST
  certificate, Shop & Establishment / trade licence, incorporation certificate,
  or a recent utility bill / bank statement in the business name.
- Your **business address, phone, and website or social page**.

> ⚠️ **Do NOT delete WhatsApp from the turf number.** If it's already on the
> WhatsApp Business app, keep it. GameOn connects via **Coexistence** (app + bot
> share one number); removing it to "migrate" locks you out of the app
> permanently. Set a **profile picture on the number before connecting**.

## Guide 1 — the fast way (≈ 5 minutes)

GameOn sends a **"Connect WhatsApp"** link (Meta's official Embedded Signup). One
guided popup creates the portfolio, sets up the WhatsApp account, adds + verifies
the number, and connects GameOn automatically — no verification paperwork up front.

1. Open the **Connect WhatsApp** link GameOn sends, on a phone or computer.
2. Log in with your **personal Facebook account** when the popup asks.
3. Choose **Create a new business portfolio** (or pick an existing one); confirm business name and email.
4. Enter the **turf's mobile number**, set the **display name** (real turf name — WhatsApp reviews it) and category (Sports/Recreation).
5. If the number is already on the WhatsApp Business app, pick **Coexistence** so you keep the app.
6. Verify the number with the **OTP** Meta sends by SMS or voice call.
7. Finish the popup — GameOn is now connected as your provider.

> 📷 **Fig 1** — the "Connect WhatsApp" popup (Meta Embedded Signup).

> 💡 Full **Business Verification** isn't required to start; the daily limit rises
> automatically over time. To remove all limits later, do Guide 2 → Part B. A blue
> badge is separate — the optional paid **Meta Verified** subscription.

## Guide 2 — the manual way

Only if there's no Connect link. ~30–45 minutes plus Meta review time. Do it on a computer.

### Part A — Create your Meta Business Portfolio

1. Go to **business.facebook.com** and log in with your personal Facebook account.
2. Click **Create a business portfolio** (older name: "Business Manager"). If you have none, you're prompted automatically.
3. Fill in your **business name**, **your name** (admin) and **business email**.
4. Click **Create**, then open Meta's confirmation email and click the link to **confirm your email**.

> 📷 **Fig 2** — account switcher → "Create a business portfolio".

### Part B — Verify the business

Proves you're a real business, raises messaging limits, unlocks full features.

1. Open **Business Settings** (gear) → **Security Centre** (or **Business Info → Verification**).
2. Click **Start verification** and enter legal business details — name, address, phone, website.
3. Enter them **exactly as they appear on your documents** — mismatches are the #1 rejection reason.
4. If Meta doesn't find you automatically, **upload a document** (GST certificate, trade licence, utility bill, bank statement) with the same legal name + address.
5. Verify the business phone/email with the code, then **Submit**. Review: minutes to a few days (occasionally ~2 weeks).

> 📷 **Fig 3** — Security Centre → Start verification.

> 💡 Verification can run in the background while you do Part C.

### Part C — Add & verify the turf's WhatsApp number

1. Go to **WhatsApp Manager** (business.facebook.com/wa/manage) inside your portfolio.
2. Choose **Add phone number** to create a new WhatsApp Business Account.
3. Set the **display name** (real turf name — WhatsApp reviews it), **category** (Sports/Recreation) and language.
4. If the number is already on the WhatsApp Business app, choose **Coexistence** so you keep the app.
5. Verify the number with the **OTP** by SMS or voice call.
6. Add GameOn as a partner: **Business Settings → Partners → Add partner**, and share your WhatsApp account with the **Partner Business ID** GameOn gives you.

> 📷 **Fig 4** — WhatsApp Manager → Add phone number.
> 📷 **Fig 5** — Business Settings → Partners → Add partner.

> ⚠️ One number per WhatsApp account; a portfolio holds a **maximum of 4
> Coexistence numbers**. Several turfs on one portfolio is fine; a very large
> operator may need more than one.

### Part D — Hand off to GameOn

Once the number shows **Connected** in WhatsApp Manager, send GameOn:

- Your **Phone Number ID** (WhatsApp Manager → your number — the numeric ID, not the phone number).
- Your **WhatsApp Business Account (WABA) ID**.
- Confirmation you've **added them as a partner**.

GameOn then wires up the booking Flow ([`FLOW_SETUP.md`](FLOW_SETUP.md)).

## If you get stuck

| What you see | What it means / how to fix it |
|---|---|
| Confirmation email never arrives | Check spam, then resend from Business Settings → Business Info. |
| Verification was rejected | Legal name/address didn't match the document — re-enter to match exactly. |
| "This number is already registered" | It's on the WhatsApp app — choose **Coexistence**, do NOT delete it. |
| The OTP never arrives | Switch SMS ↔ voice call; confirm the number can receive it right now. |
| GameOn can't see your account | You haven't shared it as a **Partner** yet — do the Add partner step, re-send the IDs. |
