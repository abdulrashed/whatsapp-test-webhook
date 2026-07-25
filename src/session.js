import { doc, getDoc, setDoc } from "firebase/firestore";

import { config } from "./config.js";
import { db } from "./firebase.js";
import { logWarn } from "./logger.js";

const COLLECTION = "wa_sessions";

// Conversation state per WhatsApp user (doc id = wa_id). Modes:
//   "bot"   — the automation drives the conversation (default)
//   "human" — customer tapped "Chat with Venue"; the bot stays silent so the
//             venue owner can reply from the WhatsApp Business app. Expires
//             after config.humanModeTtlMs, or immediately when the customer
//             types a reset keyword ("menu").
//
// Every read/write is wrapped so a Firestore failure (e.g. security rules that
// don't yet allow this collection) degrades to stateless behaviour — the menu
// still works, only the "stay silent" guarantee is lost. It never takes the
// webhook down.

export async function getSession(waId) {
  try {
    const snap = await getDoc(doc(db, COLLECTION, String(waId)));
    return snap.exists() ? snap.data() : null;
  } catch (error) {
    logWarn("Failed to read wa_session, treating as no session", {
      waId,
      error: error?.message
    });
    return null;
  }
}

export async function setMode(waId, mode, extra = {}) {
  try {
    await setDoc(
      doc(db, COLLECTION, String(waId)),
      { waId: String(waId), mode, updatedAt: Date.now(), ...extra },
      { merge: true }
    );
  } catch (error) {
    logWarn("Failed to write wa_session", { waId, mode, error: error?.message });
  }
}

// True while a handoff is active and unexpired. A missing session, an expired
// one, or a read failure all count as "not silent" so the bot never goes dark.
export function isHumanMode(session) {
  if (!session || session.mode !== "human") {
    return false;
  }
  const age = Date.now() - (session.updatedAt || 0);
  return age < config.humanModeTtlMs;
}
