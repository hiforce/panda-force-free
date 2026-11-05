import type { DataView } from "../shared/data-view.js";
import type { SessionSummary } from "../shared/engine/types.js";
import type { DirectoryEntry } from "../shared/session-discovery.js";
import type { Translate } from "../shared/i18n/messages.js";
import type { BusinessProjects } from "./contracts/features.js";
import { closestElement, requireElement } from "./dom.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml, setOpaqueText } from "./i18n.js";
import { storage, STORAGE_KEYS } from "./storage.js";

/** Owns discovery controls and paged reads; session rows remain a sidebar projection. */
export function createSidebarSessionBrowser({
  catalog,
  t,
  appendRows,
  onError,
}: {
  catalog: BusinessProjects;
  t: Translate;
  appendRows(container: HTMLElement, sessions: readonly DataView<SessionSummary>[]): void;
  onError(error: unknown): void;
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
  function render() {
    if (!host) return;
    setMessageHtml(
      host,
      `<div class="sidebar-session-tabs" role="tablist" ${messageAttributes("aria-label", "sessions.browseSessions", undefined, t)}><button type="button" role="tab" data-session-browse-view="recent" aria-selected="${view === "recent"}">${messageHtml("workbench.recentSessions", undefined, t)} <span class="sidebar-session-recent-count">10</span></button><button type="button" role="tab" data-session-browse-view="folders" aria-selected="${view === "folders"}">${messageHtml("sessions.byDirectory", undefined, t)}</button></div><div class="sidebar-session-browser-body" role="tabpanel"></div>`,
    );
    const body = requireElement(".sidebar-session-browser-body", host);
    if (view === "recent") {
      appendRows(body, recent.slice(0, 10));
      if (!recent.length) localizeText(body, "common.noMatchingSessions", undefined, t);
    } else if (directory === undefined) {
      if (!directories) {
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
        let count = 0;
        for (const entry of directories) {
          const unassigned = entry.unassignedCount ?? entry.count;
          if (!unassigned || (search && !entry.path.toLocaleLowerCase().includes(search))) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "sidebar-session-directory";
          button.dataset.sessionDirectory = entry.path;
          button.title = entry.path || t("common.noWorkingFolder");
          const label = document.createElement("span"),
            name = document.createElement("strong"),
            path = document.createElement("span"),
            total = document.createElement("small");
          path.className = "sidebar-session-directory-path";
          setOpaqueText(
            name,
            entry.path.split("/").filter(Boolean).at(-1) || entry.path || t("common.noWorkingFolder"),
          );
          setOpaqueText(path, entry.path);
          label.append(name, path);
          setOpaqueText(total, String(unassigned));
          button.append(label, total);
          button.onclick = () => {
            directory = entry.path;
            sessions = [];
            cursor = null;
            void load();
          };
          body.append(button);
          count++;
        }
        if (!count) localizeText(body, "common.noMatchingSessions", undefined, t);
      }
    } else {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "sidebar-directory-back";
      localizeText(back, "sessions.allDirectories", undefined, t);
      back.onclick = () => {
        version++;
        busy = false;
        directory = undefined;
        render();
      };
      const title = document.createElement("div");
      title.className = "sidebar-directory-path";
      title.title = directory;
      setOpaqueText(title, directory || t("common.noWorkingFolder"));
      body.append(back, title);
      appendRows(
        body,
        sessions.filter((session) => !assigned(session)),
      );
      if (busy) {
        const status = document.createElement("p");
        status.setAttribute("role", "status");
        localizeText(status, "workbench.loadingSessions", undefined, t);
        body.append(status);
      }
      if (cursor && !busy) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "sidebar-sessions-more";
        localizeText(more, "projects.loadOlderSessions", undefined, t);
        more.onclick = () => void load(true);
        body.append(more);
      } else if (!busy && !sessions.some((session) => !assigned(session))) {
        const empty = document.createElement("p");
        localizeText(empty, "common.noMatchingSessions", undefined, t);
        body.append(empty);
      }
    }
    host.onclick = (event) => {
      const button = closestElement("[data-session-browse-view]", event.target);
      if (!button) return;
      const nextView = button.dataset.sessionBrowseView;
      if (nextView !== "recent" && nextView !== "folders") return;
      view = nextView;
      storage.set(STORAGE_KEYS.sidebarUnassignedView, view);
      render();
      focusView();
      if (view === "folders" && !directories && !indexPending && !indexFailed) void readIndex();
    };
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
