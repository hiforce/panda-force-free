import type { DataView } from "../shared/data-view.js";
import type { SessionSummary } from "../shared/engine/types.js";
import type { DirectoryEntry } from "../shared/session-discovery.js";
import type { Translate } from "../shared/i18n/messages.js";
import type { BusinessProjects } from "./contracts/features.js";
import { closestElement, requireElement } from "./dom.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml } from "./i18n.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { renderSessionFolders } from "./sidebar-session-folders.js";

/** Owns discovery controls and paged reads; session rows remain a sidebar projection. */
export function createSidebarSessionBrowser({
  catalog,
  t,
  appendRows,
  directoryRoots,
  onError,
  onRender = () => {},
}: {
  catalog: BusinessProjects;
  t: Translate;
  directoryRoots(): readonly string[] | undefined;
  appendRows(container: HTMLElement, sessions: readonly DataView<SessionSummary>[]): void;
  onError(error: unknown): void;
  onRender?(): void;
}) {
  let view: "recent" | "folders" = storage.get(STORAGE_KEYS.sidebarUnassignedView) === "folders" ? "folders" : "recent";
  let host: HTMLElement | undefined;
  let recent: readonly DataView<SessionSummary>[] = [],
    search = "",
    directories: readonly DirectoryEntry[] | null = null,
    indexPending = false,
    shape = "",
    indexFailed = false,
    catalogRevision = -1;
  const expanded = new Set<string>();
  type FolderPage = { sessions: SessionSummary[]; cursor: string | null; busy: boolean; failed: boolean };
  const pages = new Map<string, FolderPage>();
  const assigned = (session: DataView<SessionSummary>) => Boolean(catalog.projectForSession(session.id));
  function focusView() {
    host?.querySelector<HTMLElement>(`[data-session-browse-view="${view}"]`)?.focus();
  }
  async function readIndex() {
    if (indexPending) return;
    indexPending = true;
    indexFailed = false;
    render();
    try {
      directories = await catalog.directoryIndex.read();
    } catch (error) {
      indexFailed = true;
      onError(error);
    } finally {
      indexPending = false;
      render();
    }
  }
  async function load(path: string, page: FolderPage) {
    try {
      const result = await catalog.history({ directory: path, search, cursor: page.cursor || "" });
      if (pages.get(path) !== page) return;
      page.sessions = [
        ...new Map([...page.sessions, ...result.sessions].map((session) => [session.id, session])).values(),
      ];
      page.cursor = result.nextCursor;
    } catch {
      if (pages.get(path) === page) page.failed = true;
    } finally {
      if (pages.get(path) === page) {
        page.busy = false;
        render();
      }
    }
  }
  function toggleDirectory(path: string) {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    render();
    host
      ?.querySelector<HTMLButtonElement>(`[data-session-directory="${CSS.escape(path)}"]`)
      ?.focus({ preventScroll: true });
  }
  function renderExpanded(body: HTMLElement, path: string) {
    let page = pages.get(path);
    if (!page) {
      const initial = { sessions: [], cursor: null, busy: true, failed: false };
      pages.set(path, initial);
      page = initial;
      queueMicrotask(() => {
        if (pages.get(path) === initial) void load(path, initial);
      });
    }
    const current = page;
    body.setAttribute("aria-busy", String(current.busy));
    const shown = current.sessions.filter(
      (session) => !assigned(session) && !catalog.wasHistorySessionRemoved(session.id),
    );
    appendRows(body, shown);
    if (current.busy || current.failed) {
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      localizeText(status, current.busy ? "workbench.loadingSessions" : "errors.couldNotLoadSessions", undefined, t);
      body.append(status);
    } else if (!current.cursor && !shown.length) {
      const empty = document.createElement("p");
      localizeText(empty, "common.noMatchingSessions", undefined, t);
      body.append(empty);
    }
    if (!current.busy && (current.failed || current.cursor)) {
      const next = document.createElement("button");
      next.type = "button";
      next.className = "sidebar-sessions-more";
      localizeText(next, current.failed ? "common.retry" : "projects.loadOlderSessions", undefined, t);
      next.onclick = () => {
        if (current.busy) return;
        current.busy = true;
        current.failed = false;
        render();
        void load(path, current);
      };
      body.append(next);
    }
  }
  function selectView(next: "recent" | "folders") {
    view = next;
    storage.set(STORAGE_KEYS.sidebarUnassignedView, view);
    render();
    focusView();
    if (view === "folders" && !directories && !indexPending && !indexFailed) void readIndex();
  }
  function render() {
    if (!host) return;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const folder = closestElement("[data-session-directory]", focused);
    const tab = closestElement("[data-session-browse-view]", focused);
    const row = closestElement(".thread-item[data-id]", focused);
    const focusSelector = folder
      ? `[data-session-directory="${CSS.escape(folder.dataset.sessionDirectory || "")}"]`
      : tab
        ? `[data-session-browse-view="${CSS.escape(tab.dataset.sessionBrowseView || "")}"]`
        : row
          ? `.thread-item[data-id="${CSS.escape(row.dataset.id || "")}"]${closestElement(".thread-options", focused) ? " .thread-options" : ""}`
          : "";
    setMessageHtml(
      host,
      `<div class="sidebar-session-tabs" role="tablist" ${messageAttributes("aria-label", "sessions.browseSessions", undefined, t)}><button type="button" role="tab" id="sidebarRecentTab" data-session-browse-view="recent" aria-controls="sidebarSessionPanel" tabindex="${view === "recent" ? 0 : -1}" aria-selected="${view === "recent"}">${messageHtml("sessions.recentTab", undefined, t)} <span class="sidebar-session-recent-count">10</span></button><button type="button" role="tab" id="sidebarFoldersTab" data-session-browse-view="folders" aria-controls="sidebarSessionPanel" tabindex="${view === "folders" ? 0 : -1}" aria-selected="${view === "folders"}" ${messageAttributes("title", "sessions.browseByFolder", undefined, t)}>${messageHtml("sessions.foldersTab", undefined, t)}</button></div><div class="sidebar-session-browser-body" id="sidebarSessionPanel" role="tabpanel" aria-labelledby="${view === "recent" ? "sidebarRecentTab" : "sidebarFoldersTab"}"></div>`,
    );
    const body = requireElement(".sidebar-session-browser-body", host);
    if (view === "recent") {
      appendRows(body, recent.slice(0, 10));
      if (!recent.length) localizeText(body, "common.noMatchingSessions", undefined, t);
    } else if (!directories) {
      localizeText(body, indexPending ? "sessions.loadingDirectories" : "sessions.directoryLoadFailed", undefined, t);
      if (!indexPending) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "sidebar-sessions-more";
        localizeText(retry, "common.retry", undefined, t);
        retry.onclick = () => void readIndex();
        body.append(retry);
      }
    } else {
      const count = renderSessionFolders({
        root: body,
        entries: directories,
        roots: directoryRoots(),
        expanded,
        search,
        t,
        toggle: toggleDirectory,
        renderExpanded,
      });
      if (!count) localizeText(body, "common.noMatchingSessions", undefined, t);
    }
    host.onclick = (event) => {
      const button = closestElement("[data-session-browse-view]", event.target);
      if (button?.dataset.sessionBrowseView === "recent" || button?.dataset.sessionBrowseView === "folders")
        selectView(button.dataset.sessionBrowseView);
    };
    host.onkeydown = (event) => {
      if (
        !closestElement("[data-session-browse-view]", event.target) ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      selectView(
        event.key === "Home" ? "recent" : event.key === "End" ? "folders" : view === "recent" ? "folders" : "recent",
      );
    };
    if (focusSelector) host.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    if (host.isConnected) onRender();
  }
  return {
    render(container: HTMLElement, threads: readonly DataView<SessionSummary>[], query = "") {
      host = container;
      recent = threads;
      if (search !== query) pages.clear();
      search = query;
      const nextShape = JSON.stringify([catalog.historyRevision, threads.map(({ id, cwd }) => [id, cwd || ""]).sort()]);
      if (shape !== nextShape || catalogRevision !== catalog.revision) {
        if (shape && shape !== nextShape) catalog.directoryIndex.invalidate();
        shape = nextShape;
        catalogRevision = catalog.revision;
        directories = null;
        pages.clear();
        indexFailed = false;
      }
      render();
      if (view === "folders" && !directories && !indexPending && !indexFailed) void readIndex();
    },
  };
}
