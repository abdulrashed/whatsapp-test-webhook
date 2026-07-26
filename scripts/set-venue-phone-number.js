// One-off helper to stamp a WhatsApp phone_number_id onto a venue_details doc.
//
// Usage:
//   node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id>
//   node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id> --write
//
// Without --write it only PRINTS the matching venue(s) so you can confirm the
// right one before touching production data. With --write it updates the doc,
// but only when exactly one venue matches the name substring.
import { collection, doc, getDocs, updateDoc } from "firebase/firestore";

import { db } from "../src/firebase.js";

const [nameArg, phoneArg, ...rest] = process.argv.slice(2);
const write = rest.includes("--write");

if (!nameArg || !phoneArg) {
  console.error('Usage: node scripts/set-venue-phone-number.js "<name substring>" <phone_number_id> [--write]');
  process.exit(1);
}

const needle = nameArg.toLowerCase();

const snap = await getDocs(collection(db, "venue_details"));
const matches = snap.docs
  .map((d) => ({ id: d.id, name: d.data().name || d.data().venue_name || "", existing: d.data().phone_number_id }))
  .filter((v) => v.name.toLowerCase().includes(needle));

if (matches.length === 0) {
  console.error(`No venue whose name contains "${nameArg}". Nothing changed.`);
  process.exit(1);
}

console.log(`Matched ${matches.length} venue(s):`);
for (const m of matches) {
  console.log(`  - ${m.id}  "${m.name}"  (current phone_number_id: ${m.existing ?? "none"})`);
}

if (!write) {
  console.log("\nDry run. Re-run with --write to set phone_number_id on the single match above.");
  process.exit(0);
}

if (matches.length > 1) {
  console.error("\nMore than one match — refusing to write. Narrow the name substring.");
  process.exit(1);
}

const target = matches[0];
await updateDoc(doc(db, "venue_details", target.id), { phone_number_id: String(phoneArg) });
console.log(`\n✅ Set phone_number_id=${phoneArg} on venue ${target.id} ("${target.name}").`);
process.exit(0);
