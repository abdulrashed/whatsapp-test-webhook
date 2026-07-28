import { collection, getDocs, limit, query, where } from "firebase/firestore";

import { config } from "./config.js";
import { db } from "./firebase.js";
import { logWarn } from "./logger.js";

const COLLECTION = "venue_details";

// Venue names are stored in upper case (e.g. "LEGENDS ARENA"). Title-case them
// for display so the WhatsApp greeting reads "Legends Arena". Display only —
// the stored value is untouched. Exported so booking copy renders the name the
// same way the greeting does.
export function toTitleCase(value) {
  return String(value)
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// Maps the WhatsApp phone_number_id that received a message to the venue it
// belongs to, so one deployment can serve many venues. Rather than a separate
// mapping collection, the venue's own venue_details doc carries a
// `phone_number_id` field:
//   venue_details/{venueId} -> { name, phone_number_id, ... }
// The document id is the venueId and `name` is the venue name already used
// throughout the GameOn app.
//
// Falls back to the VENUE_NAME env value when no venue carries this
// phone_number_id yet, so the menu still greets sensibly before onboarding.
export async function resolveVenue(phoneNumberId) {
  const fallback = { venueId: null, venueName: config.venueName };
  if (!phoneNumberId) {
    return fallback;
  }

  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTION),
        where("phone_number_id", "==", String(phoneNumberId)),
        limit(1)
      )
    );
    if (snap.empty) {
      return fallback;
    }
    const docSnap = snap.docs[0];
    const data = docSnap.data();
    const rawName = data.name || data.venue_name;
    return {
      venueId: docSnap.id,
      venueName: rawName ? toTitleCase(rawName) : config.venueName,
      // Optional per-venue custom greeting; absent on normal venue docs.
      greeting: data.wa_greeting
    };
  } catch (error) {
    logWarn("Failed to resolve venue for phone_number_id, using fallback", {
      phoneNumberId,
      error: error?.message
    });
    return fallback;
  }
}
