// Recency and expiration have one policy shared by memory and persistent adapters.
export function threadLastActivityAt(thread = {}) {
  const candidates = [thread.lastActivityAt, thread.updatedAt || thread.recencyAt];
  return Math.max(
    0,
    ...candidates.map((value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0)),
  );
}

export const CONVERSATION_CACHE_TTL_MS = 48 * 60 * 60 * 1000;
export function isConversationCacheExpired(thread, { now = Date.now(), cachedAt = now } = {}) {
  return now - (threadLastActivityAt(thread) * 1000 || cachedAt) >= CONVERSATION_CACHE_TTL_MS;
}
