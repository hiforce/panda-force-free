import { createConversationCache } from "../conversation-cache.js";
import { createConversationRepository } from "../conversation-repository.js";
import { createSidebarCache } from "../sidebar-cache.js";
import { storage, STORAGE_KEYS } from "../storage.js";

// Constructs memory/persistent history and sidebar caches with one lifecycle.
/** @param {import("./ports.js").FeatureOptions<"mutations" | "sessions" | "identity", never, "repositories">} options */
export function assembleRepositories({ mutations, sessions, identity }) {
  const persistentConversationCache = createConversationCache({ identity });
  const conversations = createConversationRepository({
    persistent: persistentConversationCache,
  });
  const sidebarCache = createSidebarCache({
    storage,
    key: STORAGE_KEYS.sidebarSnapshot,
  });
  const cachedSidebar = sidebarCache.read();
  const cacheConversation = (thread) => conversations.remember(thread);
  const evictConversationMemory = (id) => conversations.forget(id);
  const pruneConversationCaches = () => void conversations.prune();
  if (cachedSidebar) {
    sessions.replaceThreads(cachedSidebar.threads);
    mutations.edit("config", (record) => (record.home = cachedSidebar.home || ""));
  }
  return {
    conversations,
    cachedSidebar,
    pruneConversationCaches,
    cacheConversation,
    sidebarCache,
    evictConversationMemory,
    persistentConversationCache,
  };
}
