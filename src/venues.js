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
    greeting: data.wa_greeting,
    // Per-venue WhatsApp access token. In the Tech Provider model each venue's
    // number lives under its OWN WABA, so it has its own token — stored on the
    // venue doc alongside phone_number_id. Empty on venues that share GameOn's
    // own WABA; those fall back to the global config token (see
    // resolveAccessToken). This is the only secret held per-venue.
    accessToken: data.wa_access_token || "",
    // Per-venue booking Flow id. Flows live on the WABA, so each venue has its
    // own published Flow id stored here. Empty means the venue has no Flow set
    // up yet; the caller then shows a "booking not configured" message.
    flowId: data.wa_flow_id || ""
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
// Per-number token cache. The token belongs to the WABA behind a
// phone_number_id and effectively never changes (Tech Provider system-user
// tokens are long-lived), so a short TTL spares a Firestore read on every send
// without risking meaningful staleness.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map(); // phoneNumberId -> { token, expiresAt }

// Resolves the WhatsApp access token to authorize a send FROM a given
// phone_number_id. Every venue carries its own wa_access_token on its
// venue_details doc, so the token comes solely from there — there is no global
// fallback token. Returns "" when the number maps to no venue or the venue has
// no token; the caller (sendMessage) then throws a clear "missing token" error.
// Cached per number.
export async function resolveAccessToken(phoneNumberId) {
  const key = phoneNumberId || "__default__";
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.token;
  }

  let token = "";
  try {
    const { accessToken } = await resolveVenue(phoneNumberId);
    token = accessToken || "";
  } catch (error) {
    // resolveVenue already fails open; guard the token path too so a lookup
    // hiccup surfaces as a missing token rather than an unhandled rejection.
    logWarn("Failed to resolve access token", {
      phoneNumberId,
      error: error?.message
    });
  }

  tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

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
