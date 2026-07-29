import { collection, doc, getDoc, getDocs, limit, query, where } from "firebase/firestore";

import { config } from "./config.js";
import { db } from "./firebase.js";
import { logWarn } from "./logger.js";

const COLLECTION = "venue_details";

// Shown only when there is no venue to name at all — no phone_number_id match
// and no usable VENUE_ID fallback.
const GENERIC_NAME = "our venue";

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
// Shapes a venue_details snapshot into the object callers expect.
function toVenue(id, data) {
  const rawName = data.name || data.venue_name;
  return {
    venueId: id,
    venueName: rawName ? toTitleCase(rawName) : GENERIC_NAME,
    // Optional per-venue custom greeting; absent on normal venue docs.
    greeting: data.wa_greeting
  };
}

// Fallback for numbers not yet mapped to a venue. Loads the venue named by the
// VENUE_ID env var so the bot still has a real venueId to book against —
// returning a name alone would greet correctly but leave every Flow screen
// unable to load courts. Returns venueId: null only when there is genuinely no
// venue to fall back to.
async function fallbackVenue() {
  const id = config.fallbackVenueId;
  if (!id) {
    return { venueId: null, venueName: GENERIC_NAME };
  }

  try {
    const snap = await getDoc(doc(db, COLLECTION, id));
    if (!snap.exists()) {
      logWarn("VENUE_ID not found in venue_details", { venueId: id });
      return { venueId: null, venueName: GENERIC_NAME };
    }
    return toVenue(snap.id, snap.data());
  } catch (error) {
    logWarn("Failed to load fallback venue", { venueId: id, error: error?.message });
    return { venueId: null, venueName: GENERIC_NAME };
  }
}

// Falls back to the VENUE_ID venue when no venue carries this phone_number_id
// yet, so the menu still greets sensibly — and can still book — before
// onboarding.
export async function resolveVenue(phoneNumberId) {
  if (!phoneNumberId) {
    return fallbackVenue();
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
      return fallbackVenue();
    }
    const docSnap = snap.docs[0];
    return toVenue(docSnap.id, docSnap.data());
  } catch (error) {
    logWarn("Failed to resolve venue for phone_number_id, using fallback", {
      phoneNumberId,
      error: error?.message
    });
    return fallbackVenue();
  }
}
