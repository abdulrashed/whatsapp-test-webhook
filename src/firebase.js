import { getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

import { config } from "./config.js";

// Single Firestore handle against the GameOn project (turf-app-930c5), reused
// across warm invocations. This is the same client SDK the Turf-App uses, so
// booking data ports over without an auth layer. getApps() guards against
// re-initializing on a warm Vercel lambda.
const app = getApps().length ? getApps()[0] : initializeApp(config.firebase);

export const db = getFirestore(app);
