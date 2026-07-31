// Creates the `booking_confirmed` message template on a WABA.
//
// Usage:
//   node scripts/create-template.js
//   node scripts/create-template.js --write
//   node scripts/create-template.js --write --waba <waba_id>
//
// Without --write it PRINTS the payload and the template's current status on
// the WABA so you can see what would happen before touching Meta. With --write
// it POSTs the template for review.
//
// Templates live on the WABA, not the phone number, and each venue onboards
// under its OWN portfolio/WABA (coexistence allows 1 number per WABA). So this
// has to be re-run per venue at onboarding time — hence a script rather than
// clicking through WhatsApp Manager. --waba targets a venue other than the one
// in WHATSAPP_WABA_ID.
import axios from "axios";

import { config } from "../src/config.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const wabaId = valueOf("--waba") || config.wabaId;

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (!config.whatsappToken) {
  console.error("Missing WHATSAPP_TOKEN. Fill .env before running.");
  process.exit(1);
}

if (!wabaId) {
  console.error("No WABA id. Set WHATSAPP_WABA_ID in .env or pass --waba <id>.");
  process.exit(1);
}

// The single source of truth for the template's shape. If this changes after
// approval, Meta treats it as an EDIT (POST to the template id), and an
// approved template can only be edited while it is not in review — in practice
// it is easier to bump to booking_confirmed_v2 than to edit in place.
//
// Structural constraints baked in below, all of them enforced by Meta:
//   - body may not start or end with a variable
//   - a parameter value may not contain a newline, a tab, or 4+ spaces, which
//     is why the balance is folded into "Paid X of Y" instead of a
//     conditional line of its own
//   - footers take no variables, so the venue name cannot live there
export const TEMPLATE_NAME = "booking_confirmed";
export const TEMPLATE_LANGUAGE = "en";

const template = {
  name: TEMPLATE_NAME,
  language: TEMPLATE_LANGUAGE,
  category: "UTILITY",
  parameter_format: "NAMED",
  components: [
    { type: "HEADER", format: "TEXT", text: "Booking Confirmed ✅" },
    {
      type: "BODY",
      text:
        "Your slot is locked in! 🎉\n\n" +
        "🏟️ {{venue}}\n" +
        "🎾 {{sport}}\n" +
        "📅 {{date}}\n" +
        "⏰ {{time}}\n" +
        "💳 Paid ₹{{paid}} of ₹{{total}}\n\n" +
        "Show this message at the counter. See you on the turf!",
      example: {
        body_text_named_params: [
          { param_name: "venue", example: "Legend Arena" },
          { param_name: "sport", example: "Football" },
          { param_name: "date", example: "Sat, 1 Aug" },
          { param_name: "time", example: "6:00 PM – 7:00 PM" },
          { param_name: "paid", example: "200" },
          { param_name: "total", example: "1400" }
        ]
      }
    },
    { type: "FOOTER", text: 'GameOn · Reply "menu" for more options' },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "My Bookings" },
        { type: "QUICK_REPLY", text: "Book Again" }
      ]
    }
  ]
};

const templatesUrl = `https://graph.facebook.com/${config.graphApiVersion}/${wabaId}/message_templates`;
const auth = { Authorization: `Bearer ${config.whatsappToken}` };

const existing = await findExisting();

if (existing) {
  console.log(
    `Template "${TEMPLATE_NAME}" (${existing.language}) already exists on WABA ${wabaId}:\n` +
      `  id:       ${existing.id}\n` +
      `  status:   ${existing.status}\n` +
      `  category: ${existing.category}`
  );
  if (existing.status === "REJECTED") {
    console.log("\nRejected templates must be deleted before the same name can be re-submitted.");
  }
  process.exit(0);
}

if (!write) {
  console.log(`Would create on WABA ${wabaId}:\n`);
  console.log(JSON.stringify(template, null, 2));
  console.log("\nDry run. Re-run with --write to submit it for review.");
  process.exit(0);
}

try {
  const { data } = await axios.post(templatesUrl, template, {
    headers: { ...auth, "Content-Type": "application/json" },
    timeout: 15000
  });
  console.log(
    `✅ Submitted "${TEMPLATE_NAME}" to WABA ${wabaId}.\n` +
      `  id:       ${data.id}\n` +
      `  status:   ${data.status}\n` +
      `  category: ${data.category}`
  );
  if (data.category && data.category !== "UTILITY") {
    console.log(
      `\n⚠️  Meta reclassified this as ${data.category}, which is billed differently. ` +
        "Consider removing the promotional-sounding button and re-submitting."
    );
  }
  process.exit(0);
} catch (error) {
  console.error("Failed to create template:", error.response?.data || error.message);
  process.exit(1);
}

// Meta accepts a duplicate name+language POST with an error rather than
// overwriting, so check first and report the real status instead.
async function findExisting() {
  try {
    const { data } = await axios.get(templatesUrl, {
      headers: auth,
      params: { name: TEMPLATE_NAME, fields: "id,name,status,category,language" },
      timeout: 15000
    });
    return (data.data || []).find(
      (t) => t.name === TEMPLATE_NAME && t.language === TEMPLATE_LANGUAGE
    );
  } catch (error) {
    console.error("Could not list templates:", error.response?.data || error.message);
    process.exit(1);
  }
}
