// One-off helper to stamp a WhatsApp phone_number_id — and, in the Tech Provider
// model, that number's own WABA access token and booking Flow id — onto a
// venue_details doc.
//
// Usage:
//   node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id>
//   node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id> --token <access_token> --flow-id <flow_id>
//   node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id> [--token <t>] [--flow-id <f>] --write
//
// Without --write it only PRINTS the matching venue(s) so you can confirm the
// right one before touching production data. With --write it updates the doc,
// but only when exactly one venue matches the name substring.
//
// This is a multi-tenant deployment with NO global send credentials, so every
// venue needs its own access token (wa_access_token) and published Flow id
// (wa_flow_id). Pass --token and --flow-id here (or set them on the doc in a
// second pass) — a venue without them cannot send or start a booking Flow.
import { collection, doc, getDocs, updateDoc } from "firebase/firestore";

import { db } from "../src/firebase.js";

// Reads an optional "--flag <value>" pair out of argv; returns the value and the
// two indexes it occupied so they can be stripped from the positionals.
function takeFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: undefined, indexes: [] };
  return { value: args[idx + 1], indexes: [idx, idx + 1] };
}

const args = process.argv.slice(2);
const token = takeFlag(args, "--token");
const flow = takeFlag(args, "--flow-id");
const consumed = new Set([...token.indexes, ...flow.indexes]);
const positional = args.filter((a, i) => !consumed.has(i) && a !== "--write");
const [nameArg, phoneArg] = positional;
const write = args.includes("--write");

// A flag given without a value (its slot fell off the end) is a usage error.
const badFlag =
  (args.includes("--token") && !token.value) || (args.includes("--flow-id") && !flow.value);

if (!nameArg || !phoneArg || badFlag) {
  console.error(
    'Usage: node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id> [--token <access_token>] [--flow-id <flow_id>] [--write]'
  );
  process.exit(1);
}

const needle = nameArg.toLowerCase();

const snap = await getDocs(collection(db, "venue_details"));
const matches = snap.docs
  .map((d) => ({
    id: d.id,
    name: d.data().name || d.data().venue_name || "",
    existing: d.data().phone_number_id,
    hasToken: Boolean(d.data().wa_access_token),
    hasFlow: Boolean(d.data().wa_flow_id)
  }))
  .filter((v) => v.name.toLowerCase().includes(needle));

if (matches.length === 0) {
  console.error(`No venue whose name contains "${nameArg}". Nothing changed.`);
  process.exit(1);
}

console.log(`Matched ${matches.length} venue(s):`);
for (const m of matches) {
  console.log(
    `  - ${m.id}  "${m.name}"  (phone_number_id: ${m.existing ?? "none"}, token: ${m.hasToken ? "set" : "none"}, flow: ${m.hasFlow ? "set" : "none"})`
  );
}

const fields = ["phone_number_id"];
if (token.value) fields.push("wa_access_token");
if (flow.value) fields.push("wa_flow_id");
const willSet = fields.join(" + ");

if (!write) {
  console.log(`\nDry run. Re-run with --write to set ${willSet} on the single match above.`);
  process.exit(0);
}

if (matches.length > 1) {
  console.error("\nMore than one match — refusing to write. Narrow the name substring.");
  process.exit(1);
}

const target = matches[0];
const update = { phone_number_id: String(phoneArg) };
if (token.value) update.wa_access_token = String(token.value);
if (flow.value) update.wa_flow_id = String(flow.value);
await updateDoc(doc(db, "venue_details", target.id), update);
console.log(`\n✅ Set ${willSet} on venue ${target.id} ("${target.name}").`);
process.exit(0);
