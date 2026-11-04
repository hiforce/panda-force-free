import { createComposerHistory } from "./ui-core.js";
import { storage, STORAGE_KEYS } from "./storage.js";

/**
 * Composer persistence: per-thread drafts (text/mentions/attachments) in
 * localStorage and the server-backed prompt history. Reading the current
 * composer contents comes in through getDraftSnapshot.
 */
export function createComposerDrafts({
  getActiveThreadId,
  getDraftSnapshot,
  getNewDraftKey = () => "__new__",
  getLegacyNewDraftKey = () => null,
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
    if (!draft.text.trim() && !draft.mentions.length && !draft.attachments.length) composerDrafts.delete(key);
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

  const composerHistory = createComposerHistory();
  let composerHistoryLoaded = false;
  async function loadComposerHistory() {
    if (composerHistoryLoaded) return;
    composerHistoryLoaded = true;
    try {
      const response = await fetch("/api/composer/history", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      composerHistory.setPersistent(data.entries || []);
    } catch {
      composerHistoryLoaded = false;
    }
  }

  return {
    composerHistory,
    loadComposerHistory,
    persistComposerDraft,
    clearComposerDraft,
    getComposerDraft,
    setComposerDraft,
  };
}
