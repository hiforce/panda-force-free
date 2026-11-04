/**
 * Single access layer for persisted browser state (audit §3.1/§3.7).
 * All localStorage reads and writes go through here so quota or privacy-mode
 * failures degrade gracefully and every key is declared in one place.
 */
export const STORAGE_KEYS = {
  composerDrafts: "codex-webui-composer-drafts",
  activeThread: "codex-webui-active-thread",
  sidebarProjectExpansion: "codex-webui-sidebar-project-expansion",
  sidebarPinnedProjects: "codex-webui-sidebar-pinned-projects",
  sidebarPinnedThreads: "codex-webui-sidebar-pinned-threads",
  sidebarSnapshot: "codex-webui-sidebar-snapshot-v1",
  sessionModelCache: "codex-webui-session-model-cache",
  taskNotify: "codex-webui-task-notify",
  model: "codex-webui-model",
  project: "codex-webui-project",
  permissionMode: "codex-webui-permission-mode",
  permissionFullAccess: "codex-webui-permission-full-access",
  reviewPreferences: "codex-webui-review-preferences",
  effortFor: (model) => `codex-webui-effort:${model}`,
};

export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
  getJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  setJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
