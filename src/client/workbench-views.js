import { directoryKey, sessionMatches } from "../shared/session-discovery.js";
import { escapeHtml as escape } from "../shared/html.js";
import { codexIcon } from "./codex-icons.js";
import { threadLastActivityAt } from "./conversation-policy.js";
import { closestElement, findElement } from "./dom.js";
import { getBrowserI18n, messageAttributes, messageHtml, setMessageHtml } from "./i18n.js";
import { captureRenderFocus, restoreRenderFocus } from "./render-focus.js";
import { projectOverviewHeading, projectOverviewTabs } from "./creative/project-view.js";
import { createProjectDirectory } from "./projects/directory.js";
import { formatActivityAge } from "./ui-core.js";
import { createSessionListHistory, SESSION_PAGE_SIZE } from "./session-list-history.js";
/** Owns a cohesive workbench presentation surface. */
export function createWorkbenchViews({
  state,
  t,
  catalog,
  isProjectPinned,
  taskStatus,
  hasPendingApproval,
  content,
  hero,
  INTRO_KEY,
  viewState,
  identityKey,
  afterSessionListRender = () => {},
}) {
  function button(label, action, attrs = "", primary = false) {
    return `<button type="button" class="wb-button${primary ? " primary" : ""}" data-wb="${action}" ${attrs}>${messageHtml(label, undefined, t)}</button>`;
  }
  function name(path) {
    return path.split("/").filter(Boolean).at(-1) || path;
  }
  /** @returns {Array<import("../shared/data-contracts.js").ProductProject & {threads: import("../shared/data-view.js").DataView<import("../shared/engine/types.js").SessionSummary>[]}>} */
  function allProjects() {
    return catalog
      .projects()
      .sort(
        (a, b) =>
          Number(isProjectPinned("project:" + b.id)) - Number(isProjectPinned("project:" + a.id)) ||
          a.name.localeCompare(b.name),
      );
  }
  function visibleThreads() {
    return catalog.sessions();
  }
  function status(thread) {
    const actual = taskStatus(thread);
    if (
      hasPendingApproval(thread.id) ||
      actual?.state === "needs-approval" ||
      (Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : []).some((flag) =>
        /approval|input/i.test(flag),
      )
    )
      return "workbench.needsReview";
    if (actual?.state === "running" || thread.status?.type === "active") return "common.inProgress";
    if (actual?.state === "error" || thread.status?.type === "systemError") return "common.failed";
    return actual?.state === "completed" ? "sessions.completed" : "common.ready";
  }
  function taskRows(list, projectId = "") {
    if (!list.length)
      return `<div class="wb-empty"><strong>${messageHtml("workbench.noSessionsFound", undefined, t)}</strong><p>${messageHtml("workbench.createASessionOrChangeYourFiltersToGetStarted", undefined, t)}</p>${button("common.newSession", projectId ? "project-new" : "new", projectId ? `data-project-id="${escape(projectId)}"` : "", true)}</div>`;
    const { locale } = getBrowserI18n();
    const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    const now = Date.now();
    return `<div class="wb-task-list"><div class="wb-task-columns" aria-hidden="true">
      <span>${messageHtml("common.sessionName", undefined, t)}</span>
      <span>${messageHtml(projectId ? "common.workingFolder" : "common.project", undefined, t)}</span>
      <span class="wb-task-model">${messageHtml("common.model", undefined, t)}</span>
      <span>${messageHtml("common.sessionStatus", undefined, t)}</span>
      <span>${messageHtml("sessions.recentActivity", undefined, t)}</span>
      </div><div role="list">${list
        .map((thread) => {
          const id = escape(thread.id);
          const title =
            (thread.name || thread.preview || "").replace(/\s+/g, " ").trim() || t("workbench.untitledSession");
          const project = projectId ? undefined : catalog.projectForSession(thread.id);
          const folder = thread.cwd || t("common.noWorkingFolder");
          const segments = thread.cwd?.split("/").filter(Boolean) ?? [];
          const shortFolder = segments.length > 3 ? `…/${segments.slice(-2).join("/")}` : folder;
          const model = thread.threadSettings?.model || thread.model || "—";
          const activity = threadLastActivityAt(thread);
          const date = new Date(activity * 1000);
          const time =
            activity && Number.isFinite(date.getTime())
              ? `<time class="wb-task-activity" datetime="${date.toISOString()}" title="${escape(dateFormat.format(date))}" data-i18n-ignore>${escape(formatActivityAge(activity, { locale, now }))}</time>`
              : `<span class="wb-task-activity" ${messageAttributes("aria-label", "sessions.activityTimeUnavailable", undefined, t)}>—</span>`;
          const state = status(thread);
          return `<div class="wb-session-entry" role="listitem">
          <button type="button" id="wbOpenSession-${id}" class="wb-task-row" data-wb="task" data-id="${id}">
            <strong class="wb-task-title" title="${escape(title)}" data-i18n-ignore>${escape(title)}</strong>
            <span class="wb-task-location" title="${escape([project?.name, folder].filter(Boolean).join(" · "))}" data-i18n-ignore>
              ${project ? `<span class="wb-task-project">${escape(project.name)}</span>` : projectId ? "" : `<span class="wb-task-unassigned">${escape(t("common.unassigned"))}</span>`}
              <span class="wb-task-folder">${escape(shortFolder)}</span>
            </span>
            <span class="wb-task-model" title="${escape(model)}" data-i18n-ignore>${escape(model)}</span>
            <span class="wb-task-state" data-status="${state}">${messageHtml(state, undefined, t)}</span>
            ${time}
          </button>
          <button type="button" id="wbSessionOptions-${id}" class="icon-button wb-session-association" data-wb="session-options" data-id="${id}" aria-haspopup="menu" aria-expanded="false" ${messageAttributes("aria-label", "sessions.sessionOptionsForTitle", { title }, t)} ${messageAttributes("title", "sessions.sessionOptions", undefined, t)}>${codexIcon("ellipsis")}</button>
        </div>`;
        })
        .join("")}</div></div>`;
  }
  function heading(title, description, action = "", userTitle = false) {
    return `<header class="wb-page-heading"><div><h1${userTitle ? " data-i18n-ignore" : ""}>${userTitle ? escape(title) : messageHtml(title, undefined, t)}</h1><p>${messageHtml(description, undefined, t)}</p></div>${action}</header>`;
  }
  function renderTasks() {
    setMessageHtml(
      content,
      `<header class="wb-page-heading wb-sessions-toolbar">
        <div class="wb-sessions-title"><h1>${messageHtml("common.sessions", undefined, t)}</h1><div id="wbSessionCount"></div></div>
        <div class="wb-form wb-session-filters">
          <label class="wb-field"><span class="wb-control-with-icon">${codexIcon("search")}<input id="wbTaskSearch" type="search" ${messageAttributes("placeholder", "workbench.searchSessions", undefined, t)} ${messageAttributes("aria-label", "common.searchSessions", undefined, t)} value="${escape(viewState.query)}"></span></label>
          <select class="wb-select" id="wbTaskFilter" ${messageAttributes("aria-label", "common.sessionStatus", undefined, t)}>${["all", "common.inProgress", "workbench.needsReview", "common.failed", "common.ready", "sessions.completed"].map((value) => `<option value="${value}" data-pf-message="${value === "all" ? "common.allSessions" : value}" ${value === viewState.filter ? "selected" : ""}>${escape(t(value === "all" ? "common.allSessions" : value))}</option>`).join("")}</select>
        </div>${button("common.newSession", "new", "", true)}
      </header><div id="wbTaskResults"></div>`,
    );
    renderTaskResults();
  }
  const sessionHistory = createSessionListHistory((cursor) => catalog.history({ cursor }));
  let taskPage = 0;
  let taskCriteria = "";
  let taskRequest = 0;
  let taskBusy = false;
  let failedTaskPage;
  let taskDelay;
  function matchingTasks() {
    const q = viewState.query.trim().toLocaleLowerCase();
    return sessionHistory.rows(visibleThreads(), catalog.wasHistorySessionRemoved).filter((thread) => {
      if (viewState.filter !== "all" && status(thread) !== viewState.filter) return false;
      if (!q) return true;
      const project = catalog.projectForSession(thread.id);
      return [
        thread.name,
        thread.preview,
        thread.cwd,
        project?.name,
        project?.code,
        thread.threadSettings?.model || thread.model,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(q);
    });
  }
  function pageControls(page, total, more, busy = false, failed = false, compact = false) {
    const previous = page > 0;
    const next = (page + 1) * SESSION_PAGE_SIZE < total || more;
    if (!previous && !next && (compact || (!busy && !failed))) return "";
    return `<nav class="wb-session-pages${compact ? " compact" : ""}" ${messageAttributes("aria-label", "sessions.browseSessions", undefined, t)}>
      ${compact ? "" : `<span role="status">${busy ? messageHtml("workbench.loadingSessions", undefined, t) : failed ? messageHtml("errors.couldNotLoadSessions", undefined, t) : ""}</span>`}
      ${failed && !compact ? `<button type="button" class="wb-button" data-session-page="retry">${messageHtml("common.retry", undefined, t)}</button>` : ""}
      <button type="button" class="wb-button wb-session-page-step" data-session-page="previous" ${!previous || busy ? "disabled" : ""} ${messageAttributes("aria-label", "notifications.previous", undefined, t)}>${codexIcon("chevronLeft")}</button>
      ${more ? messageHtml("notifications.page", { number: page + 1 }, t) : messageHtml("projects.pagePosition", { page: page + 1, pages: Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE)) }, t)}
      <button type="button" class="wb-button wb-session-page-step" data-session-page="next" ${!next || busy ? "disabled" : ""} ${messageAttributes("aria-label", "notifications.next", undefined, t)}>${codexIcon("chevronRight")}</button>
    </nav>`;
  }
  function taskPageRows() {
    const results = findElement("#wbTaskResults");
    if (!results || viewState.route.page !== "tasks") return;
    const list = matchingTasks();
    if (!sessionHistory.hasMore)
      taskPage = Math.min(taskPage, Math.max(0, Math.ceil(list.length / SESSION_PAGE_SIZE) - 1));
    const page = list.slice(taskPage * SESSION_PAGE_SIZE, (taskPage + 1) * SESSION_PAGE_SIZE);
    setMessageHtml(
      findElement("#wbSessionCount"),
      pageControls(taskPage, list.length, sessionHistory.hasMore, taskBusy, false, true) ||
        messageHtml("sessions.count", { count: list.length }, t),
    );
    const focus = captureRenderFocus(results);
    const active = document.activeElement;
    const step = active instanceof HTMLElement && results.contains(active) ? active.dataset.sessionPage : undefined;
    results.setAttribute("aria-busy", String(taskBusy));
    setMessageHtml(
      results,
      (page.length || (!taskBusy && !failedTaskPage && !sessionHistory.hasMore) ? taskRows(page) : "") +
        pageControls(taskPage, list.length, sessionHistory.hasMore, taskBusy, Boolean(failedTaskPage)),
    );
    if (step) findElement(`[data-session-page="${CSS.escape(step)}"]:enabled`, results)?.focus({ preventScroll: true });
    else restoreRenderFocus(results, focus);
    afterSessionListRender();
  }
  async function loadTaskPage(target, move = false) {
    const request = ++taskRequest;
    let moved = false;
    taskBusy = true;
    failedTaskPage = undefined;
    taskPageRows();
    try {
      while (
        request === taskRequest &&
        viewState.route.page === "tasks" &&
        sessionHistory.hasMore &&
        (!sessionHistory.initialized || matchingTasks().length <= (target + 1) * SESSION_PAGE_SIZE)
      )
        await sessionHistory.more();
      if (
        request === taskRequest &&
        viewState.route.page === "tasks" &&
        move &&
        matchingTasks().length > target * SESSION_PAGE_SIZE
      ) {
        taskPage = target;
        moved = true;
      }
    } catch {
      if (request === taskRequest) failedTaskPage = { target, move };
    } finally {
      if (request === taskRequest) {
        taskBusy = false;
        taskPageRows();
        if (moved) focusSessionPage("#wbTaskResults");
        else if (move && failedTaskPage)
          findElement('#wbTaskResults [data-session-page="retry"]')?.focus({ preventScroll: true });
      }
    }
  }
  function focusSessionPage(selector) {
    const first = findElement(selector + " .wb-task-row");
    if (!first) return;
    first.focus({ preventScroll: true });
    content.closest(".workbench-view")?.scrollTo({ top: 0 });
  }
  function renderTaskResults() {
    const criteria = JSON.stringify([viewState.query.trim().toLocaleLowerCase(), viewState.filter]);
    const changed = criteria !== taskCriteria;
    if (changed) {
      taskCriteria = criteria;
      taskPage = 0;
      failedTaskPage = undefined;
    }
    if (
      changed ||
      (!taskBusy &&
        !failedTaskPage &&
        sessionHistory.hasMore &&
        (!sessionHistory.initialized || matchingTasks().length <= (taskPage + 1) * SESSION_PAGE_SIZE))
    ) {
      taskRequest++;
      taskBusy = true;
      clearTimeout(taskDelay);
      taskDelay = setTimeout(
        () => {
          if (viewState.route.page === "tasks") void loadTaskPage(taskPage);
          else taskBusy = false;
        },
        changed && sessionHistory.initialized && viewState.query.trim() ? 220 : 0,
      );
    }
    taskPageRows();
  }
  const projectDirectory = createProjectDirectory({ root: content, t, catalog, isProjectPinned, identityKey });
  const renderProjects = projectDirectory.render;
  /** @type {Map<string, {search: string; directory: string | undefined; page: number}>} */
  const projectSessionFilters = new Map();
  /** @param {string} id */
  function projectSessionFilter(id) {
    let filter = projectSessionFilters.get(id);
    if (!filter) {
      filter = { search: "", directory: undefined, page: 0 };
      projectSessionFilters.set(id, filter);
    }
    return filter;
  }
  function renderProjectSessionResults() {
    const project = allProjects().find((entry) => entry.id === viewState.route.id);
    if (!project) return;
    const filter = projectSessionFilter(project.id);
    const list = project.threads.filter(
      (session) => !catalog.wasHistorySessionRemoved(session.id) && sessionMatches(session, filter),
    );
    list.sort((a, b) => threadLastActivityAt(b) - threadLastActivityAt(a) || a.id.localeCompare(b.id));
    filter.page = Math.min(filter.page, Math.max(0, Math.ceil(list.length / SESSION_PAGE_SIZE) - 1));
    setMessageHtml(
      findElement("#projectSessionResults"),
      taskRows(list.slice(filter.page * SESSION_PAGE_SIZE, (filter.page + 1) * SESSION_PAGE_SIZE), project.id) +
        pageControls(filter.page, list.length, false),
    );
    afterSessionListRender();
  }
  /** @param {string} value */
  function searchProjectSessions(value) {
    const filter = projectSessionFilter(viewState.route.id);
    filter.search = value;
    filter.page = 0;
    renderProjectSessionResults();
  }
  /** @param {string} value */
  function filterProjectDirectory(value) {
    const filter = projectSessionFilter(viewState.route.id);
    filter.directory = value === "*" ? undefined : value;
    filter.page = 0;
    renderProjectSessionResults();
  }
  content.addEventListener("click", (event) => {
    const action = closestElement("[data-session-page]", event.target)?.dataset.sessionPage;
    if (!action) return;
    const step = action === "previous" ? -1 : 1;
    if (viewState.route.page === "tasks") {
      if (taskBusy) return;
      const target = Math.max(0, taskPage + step);
      if (action === "retry") {
        if (failedTaskPage) void loadTaskPage(failedTaskPage.target, failedTaskPage.move);
      } else if (step < 0 || matchingTasks().length > (target + 1) * SESSION_PAGE_SIZE || !sessionHistory.hasMore) {
        taskPage = target;
        taskPageRows();
        focusSessionPage("#wbTaskResults");
      } else void loadTaskPage(target, true);
    } else if (viewState.route.page === "project") {
      const filter = projectSessionFilter(viewState.route.id);
      filter.page = Math.max(0, filter.page + step);
      renderProjectSessionResults();
      focusSessionPage("#projectSessionResults");
    }
  });
  function renderProject() {
    const p = allProjects().find((p) => p.id === viewState.route.id);
    if (!p) {
      setMessageHtml(
        content,
        heading(
          catalog.ready ? "workbench.projectUnavailable" : "common.loadingProjects2",
          "common.chooseAProjectToContinue",
          button("common.projects", "route", 'data-route="projects"'),
        ),
      );
      return;
    }
    const filter = projectSessionFilter(p.id);
    const directories = [...new Set(p.threads.map((session) => directoryKey(session.cwd || "")))].sort();
    const workspaceInfo = p.workspace
      ? `<details class="project-session-location"><summary>${codexIcon("folderOpen")}${messageHtml("projects.workspacePath", undefined, t)}</summary><code data-i18n-ignore>${escape(p.workspace.path)}</code>${p.workspace.state !== "ready" ? `<p role="status">${messageHtml("projects.workspacePreparing", undefined, t)}</p>` : ""}</details>`
      : "";
    setMessageHtml(
      content,
      `<section class="project-overview project-sessions-view">${projectOverviewHeading(t, p.id, p, button("common.linkExistingSessions", "project-link", `data-project-id="${escape(p.id)}"`) + button("common.newSession", "project-new", `data-project-id="${escape(p.id)}"`, true))}${projectOverviewTabs(t, p.id, "sessions")}
      <header class="project-section-heading"><div><h2>${messageHtml("workbench.projectSessions", undefined, t)}</h2><p>${messageHtml("projects.sessionsHint", undefined, t)}</p></div><span class="resource-badge">${messageHtml("sessions.count", { count: p.threads.length }, t)}</span></header>
      <div class="project-session-tools wb-form"><label class="wb-field"><span>${messageHtml("common.searchSessions", undefined, t)}</span><span class="wb-control-with-icon">${codexIcon("search")}<input id="projectSessionSearch" type="search" ${messageAttributes("placeholder", "workbench.searchSessions", undefined, t)} value="${escape(filter.search)}"></span></label><label class="wb-field"><span>${messageHtml("sessions.byDirectory", undefined, t)}</span><select id="projectSessionDirectory"><option value="*">${escape(t("sessions.allDirectories"))}</option>${directories.map((path) => `<option value="${escape(path)}" title="${escape(path)}" ${path === filter.directory ? "selected" : ""}>${escape(path || t("common.noWorkingFolder"))}</option>`).join("")}</select></label></div>${workspaceInfo}<div id="projectSessionResults"></div></section>`,
    );
    renderProjectSessionResults();
  }
  function renderConnections() {
    setMessageHtml(
      content,
      heading("common.connections", "common.yourToolsWithClearCapabilitiesAndConnectionStatus") +
        `<div class="wb-project-grid"><article class="wb-card"><div class="wb-section-heading"><h2 data-i18n-ignore>${escape(state.config.engine?.name || "Codex")}</h2><span class="wb-status">${messageHtml(state.connected ? "common.connected" : "common.disconnected", undefined, t)}</span></div><p>${messageHtml("workbench.yourCurrentExecutionEngineModelAuthenticationIsSeparateFromYour", undefined, t)}</p>${button("common.modelAndPermissions", "settings", 'data-page="agent"')}${button("common.usage", "settings", 'data-page="usage"')}</article></div>`,
    );
  }
  function renderDeliverables() {
    setMessageHtml(
      content,
      heading("common.deliverables", "common.inspectFilesInTheirTaskContext") +
        `<div class="wb-card"><h2>${messageHtml("workbench.filesFromYourSessions", undefined, t)}</h2><p>${messageHtml("workbench.openASessionToBrowseAndPreviewFilesFromIts", undefined, t)}</p>${button("common.browseSessionFiles", "files")}${button("common.sessions", "route", 'data-route="tasks"')}</div>`,
    );
  }
  return {
    button,
    name,
    allProjects,
    visibleThreads,
    status,
    taskRows,
    heading,
    renderTasks,
    renderTaskResults,
    renderProjects,
    renderProject,
    renderProjectSessionResults,
    searchProjectSessions,
    filterProjectDirectory,
    renderConnections,
    renderDeliverables,
  };
}
