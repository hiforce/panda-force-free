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
  onError,
  onRender = () => {},
}: {
  catalog: BusinessProjects;
  t: Translate;
  appendRows(container: HTMLElement, sessions: readonly DataView<SessionSummary>[]): void;
  onError(error: unknown): void;
  onRender?(): void;
}) {
  let view: "recent" | "folders" = storage.get(STORAGE_KEYS.sidebarUnassignedView) === "folders" ? "folders" : "recent";
  let host: HTMLElement | undefined;
  let recent: readonly DataView<SessionSummary>[] = [],
    search = "",
    directory: string | undefined,
    loadedSearch = "",
    cursor: string | null = null;
  let directories: readonly DirectoryEntry[] | null = null;
  let sessions: SessionSummary[] = [],
    busy = false,
    indexPending = false,
    version = 0;
  let shape = "",
    indexFailed = false,
    catalogRevision = -1;
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
  async function load(append = false) {
    const request = ++version;
    const path = directory;
    busy = true;
    loadedSearch = search;
    render();
    try {
      const result = await catalog.history({ directory: path, search, cursor: append ? cursor || "" : "" });
      if (request !== version) return;
      sessions = [
        ...new Map([...(append ? sessions : []), ...result.sessions].map((session) => [session.id, session])).values(),
      ];
      cursor = result.nextCursor;
    } catch (error) {
      if (request === version) onError(error);
    } finally {
      if (request === version) {
        busy = false;
        render();
      }
    }
  }
  function toggleDirectory(path: string) {
    version++;
    busy = false;
    if (directory === path) {
      directory = undefined;
      render();
    } else {
      directory = path;
      sessions = [];
      cursor = null;
      void load();
    }
    host
      ?.querySelector<HTMLButtonElement>(`[data-session-directory="${CSS.escape(path)}"]`)
      ?.focus({ preventScroll: true });
  }
  function renderExpanded(body: HTMLElement) {
    body.setAttribute("aria-busy", String(busy));
    appendRows(
      body,
      sessions.filter((session) => !assigned(session)),
    );
    if (busy) {
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      localizeText(status, "workbench.loadingSessions", undefined, t);
      body.append(status);
    } else if (cursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "sidebar-sessions-more";
      localizeText(more, "projects.loadOlderSessions", undefined, t);
      more.onclick = () => void load(true);
      body.append(more);
    } else if (!sessions.some((session) => !assigned(session))) {
      const empty = document.createElement("p");
      localizeText(empty, "common.noMatchingSessions", undefined, t);
      body.append(empty);
    }
  }
  function selectView(next: "recent" | "folders") {
    view = next;
    storage.set(STORAGE_KEYS.sidebarUnassignedView, view);
    render();
    focusView();
    if (view === "folders" && !directories && !indexPending && !indexFailed) void readIndex();
    else if (view === "folders" && directory !== undefined && loadedSearch !== search) void load();
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
        expanded: directory,
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
      search = query;
      const nextShape = JSON.stringify(threads.map(({ id, cwd }) => [id, cwd || ""]).sort());
      if (shape !== nextShape || catalogRevision !== catalog.revision) {
        if (shape && shape !== nextShape) catalog.directoryIndex.invalidate();
        shape = nextShape;
        catalogRevision = catalog.revision;
        directories = null;
        indexFailed = false;
      }
      render();
      if (view === "folders" && !directories && !indexPending && !indexFailed) void readIndex();
      if (view === "folders" && directory !== undefined && loadedSearch !== search) void load();
    },
  };
}
