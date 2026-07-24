const DEFAULT_TTL_MS = 10 * 60 * 1000;
const seenEvents = new Map();

export function hasSeenEvent(eventId) {
  if (!eventId) {
    return false;
  }

  cleanupExpiredEvents();

  if (seenEvents.has(eventId)) {
    return true;
  }

  seenEvents.set(eventId, Date.now() + DEFAULT_TTL_MS);
  return false;
}

function cleanupExpiredEvents() {
  const now = Date.now();
  for (const [eventId, expiresAt] of seenEvents.entries()) {
    if (expiresAt <= now) {
      seenEvents.delete(eventId);
    }
  }
}
