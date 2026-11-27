import { migrateBrowserState } from "./legacy-browser-state.js";
migrateBrowserState();

/**
 * Single access layer for persisted browser state (audit §3.1/§3.7).
 * All localStorage reads and writes go through here so quota or privacy-mode
 * failures degrade gracefully and every key is declared in one place.
 */
export const STORAGE_KEYS = {
  layout: "panda-force-layout",
  memoryMapLayout: "panda-force-memory-map-layout",
  sidebarOpen: "panda-force-sidebar-open",
  sidebarWidth: "panda-force-sidebar-width",
  sessionDetailsOpen: "panda-force-session-details-open",
  composerDrafts: "panda-force-composer-drafts",
  composerDisclosureFor: (identity) => `panda-force-composer-disclosure:${encodeURIComponent(identity)}`,
  creationSnapshotFor: (identity, key) =>
    `panda-force-creation-snapshot:${encodeURIComponent(identity)}:${encodeURIComponent(key)}`,
  skillCategoriesFor: (identity) => `panda-force-skill-categories:${encodeURIComponent(identity)}`,
  creationFollowUpFor: (identity, scope, task) =>
    `panda-force-creation-follow-up:${encodeURIComponent(identity)}:${scope}:${task}`,
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
  projectDirectoryFor: (identity) => `panda-force-project-directory:${encodeURIComponent(identity)}`,
  workspaceToolsFor: (identity) => `panda-force-workspace-tools:${encodeURIComponent(identity)}`,
  sessionToolsFor: (identity) => `panda-force-session-tools:${encodeURIComponent(identity)}`,
  sessionToolDataFor: (identity, session) =>
    `panda-force-session-tool-data:${encodeURIComponent(identity)}:${encodeURIComponent(session)}`,
  documentDraftFor: (identity, document) =>
    `panda-force-document-draft:${encodeURIComponent(identity)}:${encodeURIComponent(document)}`,
  documentTreeFor: (identity, project) =>
    `panda-force-document-tree:${encodeURIComponent(identity)}:${encodeURIComponent(project)}`,
  documentSelectionFor: (identity, project) =>
    `panda-force-document-selection:${encodeURIComponent(identity)}:${encodeURIComponent(project)}`,
  documentTreeCommandFor: (identity, project) =>
    `panda-force-document-tree-command:${encodeURIComponent(identity)}:${encodeURIComponent(project)}`,
  documentPublicationCommandFor: (identity, project) =>
    `panda-force-document-publication-command:${encodeURIComponent(identity)}:${encodeURIComponent(project)}`,
  effortFor: (model) => `panda-force-effort:${model}`,
};

export const storage = {
  getSessionJson(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  setSessionJson(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  removeSession(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {}
  },
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

/** Document mutation recovery must fail visibly before a request when browser storage is unavailable. */
export const documentRecoveryStorage = {
  getItem(key) {
    return sessionStorage.getItem(key);
  },
  setItem(key, value) {
    sessionStorage.setItem(key, value);
  },
  removeItem(key) {
    sessionStorage.removeItem(key);
  },
};
