import { doc, getDoc } from "firebase/firestore";

import { config } from "./config.js";
import { db } from "./firebase.js";
import { logWarn } from "./logger.js";

const COLLECTION = "wa_numbers";

// Maps the WhatsApp phone_number_id that received a message to the venue it
// belongs to, so one deployment can serve many venues. Doc shape:
//   wa_numbers/{phone_number_id} -> { venueId, venueName, greeting? }
//
// Falls back to the VENUE_NAME env value when no mapping exists yet (e.g. the
// throwaway test number), so the menu still greets sensibly before any venue
// is onboarded.
export async function resolveVenue(phoneNumberId) {
  const fallback = { venueId: null, venueName: config.venueName };
  if (!phoneNumberId) {
    return fallback;
  }

  try {
    const snap = await getDoc(doc(db, COLLECTION, String(phoneNumberId)));
    if (!snap.exists()) {
      return fallback;
    }
    const data = snap.data();
    return {
      venueId: data.venueId ?? null,
      venueName: data.venueName || config.venueName,
      greeting: data.greeting
    };
  } catch (error) {
    logWarn("Failed to resolve venue for phone_number_id, using fallback", {
      phoneNumberId,
      error: error?.message
    });
    return fallback;
  }
}
