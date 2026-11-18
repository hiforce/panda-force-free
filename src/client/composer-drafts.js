import { request as fetch } from "./http-client.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { createComposerHistory } from "./ui-core.js";

/**
 * Composer persistence: per-thread drafts (text/mentions/attachments) in
 * localStorage and the server-backed prompt history. Reading the current
 * composer contents comes in through getDraftSnapshot.
 */
export function createComposerDrafts({
  getActiveThreadId,
  getDraftSnapshot,
  getNewDraftKey = () => "__new__",
  getLegacyNewDraftKey = /** @type {() => string | null} */ (() => null),
  migrateLegacyGlobalDraft = () => true,
}) {
  const composerDrafts = (() => {
    try {
      const value = JSON.parse(storage.get(STORAGE_KEYS.composerDrafts) || "{}");
      return new Map(Object.entries(value).filter(([, draft]) => draft && typeof draft === "object"));
    } catch {
      return new Map();
    }
  })();
  function persistComposerDrafts() {
    try {
      storage.set(
        STORAGE_KEYS.composerDrafts,
        JSON.stringify(
          Object.fromEntries(
            [...composerDrafts].map(([key, draft]) => [
              key,
              {
                ...draft,
                attachments: (draft.attachments || []).filter((attachment) => attachment.status === "ready"),
              },
            ]),
          ),
        ),
      );
    } catch {}
  }
  function composerDraftKey(threadId = getActiveThreadId()) {
    return threadId || getNewDraftKey();
  }
  function persistComposerDraft() {
    const key = composerDraftKey(),
      draft = getDraftSnapshot();
    if (!draft.text.trim() && !draft.mentions.length && !draft.attachments.length && !draft.skills)
      composerDrafts.delete(key);
    else composerDrafts.set(key, draft);
    persistComposerDrafts();
  }
  function clearComposerDraft(threadId) {
    composerDrafts.delete(composerDraftKey(threadId));
    persistComposerDrafts();
  }
  function getComposerDraft(threadId) {
    const key = composerDraftKey(threadId);
    const legacy = !threadId && getLegacyNewDraftKey();
    if (legacy && legacy !== key && !composerDrafts.has(key) && composerDrafts.has(legacy)) {
      composerDrafts.set(key, composerDrafts.get(legacy));
      composerDrafts.delete(legacy);
      persistComposerDrafts();
    }
    // Preserve the single legacy new-task draft once, in the first chosen project.
    if (
      !threadId &&
      migrateLegacyGlobalDraft() &&
      key !== "__new__" &&
      !composerDrafts.has(key) &&
      composerDrafts.has("__new__")
    ) {
      composerDrafts.set(key, composerDrafts.get("__new__"));
      composerDrafts.delete("__new__");
      persistComposerDrafts();
    }
    return composerDrafts.get(key);
  }
  function setComposerDraft(threadId, draft) {
    composerDrafts.set(composerDraftKey(threadId), draft);
    persistComposerDrafts();
  }

  function updateAttachment(id, patch) {
    for (const [key, draft] of composerDrafts) {
      if (!draft.attachments?.some((attachment) => attachment.id === id)) continue;
      composerDrafts.set(key, {
        ...draft,
        attachments: draft.attachments.map((attachment) =>
          attachment.id === id ? { ...attachment, ...patch, id } : attachment,
        ),
      });
    }
    persistComposerDrafts();
  }

  const composerHistory = createComposerHistory();
  let composerHistoryLoaded = false;
  /** @type {string | null} */
  let historyCursor = null;
  /** @type {Promise<void> | null} */
  let historyRead = null;
  function loadComposerHistory() {
    if (historyRead) return historyRead;
    if (composerHistoryLoaded && !historyCursor) return Promise.resolve();
    historyRead = (async () => {
      const signal = AbortSignal.timeout(15000);
      for (;;) {
        const query = new URLSearchParams({ limit: "20", ...(historyCursor ? { cursor: historyCursor } : {}) });
        const response = await fetch("/api/composer/history?" + query, { cache: "no-store", signal });
        if (!response.ok) {
          if (response.status === 409) {
            composerHistoryLoaded = false;
            historyCursor = null;
          }
          if ([401, 403].includes(response.status)) composerHistory.setPersistent([]);
          throw new Error("Input history read failed");
        }
        const data = await response.json();
        if (
          !Array.isArray(data.entries) ||
          data.entries.some((entry) => typeof entry?.text !== "string") ||
          (data.nextCursor !== null && (typeof data.nextCursor !== "string" || data.nextCursor === historyCursor))
        )
          throw new Error("Invalid input history response");
        composerHistory.prependPersistent(data.entries);
        historyCursor = data.nextCursor;
        composerHistoryLoaded = true;
        // A page containing only disallowed sessions is not the end of the caller's history.
        if (data.entries.length || !historyCursor) return;
      }
    })().finally(() => {
      historyRead = null;
    });
    return historyRead;
  }

  return {
    composerHistory,
    loadComposerHistory,
    persistComposerDraft,
    clearComposerDraft,
    getComposerDraft,
    setComposerDraft,
    updateAttachment,
  };
}
