import { migrateBrowserState } from "./legacy-browser-state.js";
migrateBrowserState();

/**
 * Single access layer for persisted browser state (audit §3.1/§3.7).
 * All localStorage reads and writes go through here so quota or privacy-mode
 * failures degrade gracefully and every key is declared in one place.
 */
export const STORAGE_KEYS = {
  composerDrafts: "panda-force-composer-drafts",
  activeThread: "panda-force-active-thread",
  sidebarUnassignedView: "panda-force-sidebar-unassigned-view",
  sidebarProjectExpansion: "panda-force-sidebar-project-expansion",
  sidebarPinnedProjects: "panda-force-sidebar-pinned-projects",
  sidebarPinnedThreads: "panda-force-sidebar-pinned-threads",
  sidebarSnapshot: "panda-force-sidebar-snapshot-v1",
  sessionModelCache: "panda-force-session-model-cache",
  taskNotify: "panda-force-task-notify",
  model: "panda-force-model",
  project: "panda-force-project",
  permissionMode: "panda-force-permission-mode",
  permissionFullAccess: "panda-force-permission-full-access",
  reviewPreferences: "panda-force-review-preferences",
  effortFor: (model) => `panda-force-effort:${model}`,
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
