import { directoryKey, sessionMatches } from "../shared/session-discovery.js";
import { escapeHtml as escape } from "../shared/html.js";
import { codexIcon } from "./codex-icons.js";
import { findElement } from "./dom.js";
import { messageAttributes, messageHtml, setMessageHtml } from "./i18n.js";
import { storage } from "./storage.js";
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
  function taskRows(list) {
    if (!list.length)
      return `<div class="wb-empty"><strong>${messageHtml("workbench.noSessionsFound", undefined, t)}</strong><p>${messageHtml("workbench.createASessionOrChangeYourFiltersToGetStarted", undefined, t)}</p>${button("common.newSession", "new", "", true)}</div>`;
    return `<div class="wb-task-list">${list
      .slice(0, 100)
      .map((thread) => {
        const project = catalog.projectForSession(thread.id);
        return `<div class="wb-session-entry"><button type="button" class="wb-task-row" data-wb="task" data-id="${escape(thread.id)}"><span class="wb-task-icon">${codexIcon("messageSquare")}</span><span class="wb-task-copy" data-i18n-ignore><strong>${escape((thread.name || thread.preview || t("workbench.untitledSession")).replace(/\s+/g, " ").slice(0, 110))}</strong><small>${escape(project?.name || t("common.unassigned"))} · ${escape(thread.cwd || t("common.noWorkingFolder"))}</small></span><span class="wb-status ${status(thread) === "common.inProgress" ? "running" : status(thread) === "workbench.needsReview" ? "review" : ""}">${messageHtml(status(thread), undefined, t)}</span></button><button type="button" class="icon-button wb-session-association" data-wb="session-project" data-id="${escape(thread.id)}" ${messageAttributes("aria-label", "common.changeProject", undefined, t)} ${messageAttributes("title", "common.changeProject", undefined, t)}>${codexIcon("ellipsis")}</button></div>`;
      })
      .join(
        "",
      )}</div>${list.length > 100 ? `<p class="wb-list-limit">${messageHtml("workbench.showingTheFirst100MatchesRefineYourSearchToFind", undefined, t)}</p>` : ""}`;
  }
  function heading(title, description, action = "", userTitle = false) {
    return `<header class="wb-page-heading"><div><h1${userTitle ? " data-i18n-ignore" : ""}>${userTitle ? escape(title) : messageHtml(title, undefined, t)}</h1><p>${messageHtml(description, undefined, t)}</p></div>${action}</header>`;
  }
  function renderHome() {
    setMessageHtml(
      hero,
      `<div class="wb-hero"><p class="wb-eyebrow">${messageHtml("workbench.yourNextMove", undefined, t)}</p><h1>${messageHtml("workbench.whatWouldYouLikeToGetDone", undefined, t)}</h1><p>${messageHtml("workbench.startWithAGoalStayInControlAndReviewThe", undefined, t)}</p></div>`,
    );
    const threads = visibleThreads();
    setMessageHtml(
      content,
      `<div class="wb-quick-actions">${[
        ["workbench.reviewAProject", "Review a project"],
        ["workbench.prepareAPlan", "Prepare a plan"],
        ["workbench.explainThisProject", "Explain this project"],
      ]
        .map(([label, prompt]) => button(label, "template", `data-template="${escape(prompt)}"`))
        .join(
          "",
        )}</div><div class="wb-metrics"><button data-wb="running"><strong>${threads.filter((x) => status(x) === "common.inProgress").length}</strong><span>${messageHtml("common.inProgress", undefined, t)}</span></button><button data-wb="review"><strong>${threads.filter((x) => status(x) === "workbench.needsReview").length}</strong><span>${messageHtml("workbench.needsReview", undefined, t)}</span></button><button data-wb="route" data-route="projects"><strong>${allProjects().length}</strong><span>${messageHtml("common.projects", undefined, t)}</span></button></div>${!storage.get(INTRO_KEY) ? `<aside class="wb-introduction"><div><strong>${messageHtml("workbench.fromAGoalToAResult", undefined, t)}</strong><p>${messageHtml("workbench.chooseAProjectToOrganizeSessionsSelectAWorkingFolder", undefined, t)}</p></div>${button("common.gotIt", "dismiss-intro")}</aside>` : ""}<div class="wb-section-heading"><h2>${messageHtml("workbench.recentSessions", undefined, t)}</h2>${button("common.viewAllSessions", "route", 'data-route="tasks"')}</div>${taskRows(threads.slice(0, 8))}`,
    );
  }
  function renderTasks() {
    setMessageHtml(
      content,
      heading(
        "common.sessions",
        "common.browseSessionsAndTheirProjectAssociations",
        button("common.newSession", "new", "", true),
      ) +
        `<div class="wb-filter-row"><input id="wbTaskSearch" type="search" ${messageAttributes("placeholder", "workbench.searchSessions", undefined, t)} ${messageAttributes("aria-label", "common.searchSessions", undefined, t)} value="${escape(viewState.query)}"><select id="wbTaskFilter" ${messageAttributes("aria-label", "common.sessionStatus", undefined, t)}>${["all", "common.inProgress", "workbench.needsReview", "common.failed", "common.ready", "sessions.completed"].map((value) => `<option value="${value}" data-pf-message="${value === "all" ? "common.allSessions" : value}" ${value === viewState.filter ? "selected" : ""}>${escape(t(value === "all" ? "common.allSessions" : value))}</option>`).join("")}</select></div><div id="wbTaskResults"></div>`,
    );
    renderTaskResults();
  }
  function renderTaskResults() {
    const q = viewState.query.trim().toLocaleLowerCase();
    setMessageHtml(
      findElement("#wbTaskResults"),
      taskRows(
        visibleThreads().filter(
          (x) =>
            (viewState.filter === "all" || status(x) === viewState.filter) &&
            [x.name, x.preview, x.cwd, catalog.projectForSession(x.id)?.name, catalog.projectForSession(x.id)?.code]
              .join(" ")
              .toLocaleLowerCase()
              .includes(q),
        ),
      ),
    );
  }
  function projectCard(p) {
    return `<article class="wb-project"><button class="wb-project-main" data-i18n-ignore data-wb="project" data-project-id="${escape(p.id)}"><span>${codexIcon("folderOpen")}</span><strong>${escape(p.name)}</strong><small class="project-code">${escape(p.code)}</small><p class="project-description">${escape(p.description || "")}</p><small>${messageHtml("sessions.count", { count: p.threads.length }, t)}</small></button><div class="wb-project-actions">${button("common.newSession", "project-new", `data-project-id="${escape(p.id)}"`)}${button(isProjectPinned("project:" + p.id) ? "common.unpin" : "common.pin", "pin", `data-project-id="${escape(p.id)}"`)}</div></article>`;
  }
  function renderProjects() {
    setMessageHtml(
      content,
      heading(
        "common.projects",
        "common.createProjectsAndOrganizeTheirSessions",
        button("common.createProject", "create-project", "", true),
      ) +
        `<div class="wb-filter-row"><input id="wbProjectSearch" type="search" ${messageAttributes("aria-label", "workbench.searchProjects", undefined, t)} ${messageAttributes("placeholder", "workbench.searchProjects2", undefined, t)} value="${escape(viewState.projectQuery)}"></div><div class="wb-project-grid" id="wbProjectResults"></div>`,
    );
    renderProjectResults();
  }
  function renderProjectResults() {
    const list = allProjects().filter((p) =>
      [p.name, p.code, p.description]
        .join(" ")
        .toLocaleLowerCase()
        .includes(viewState.projectQuery.trim().toLocaleLowerCase()),
    );
    setMessageHtml(
      findElement("#wbProjectResults"),
      !catalog.ready
        ? `<p>${messageHtml("common.loadingProjects2", undefined, t)}</p>`
        : list.length
          ? list.map(projectCard).join("")
          : `<div class="wb-empty"><h2>${messageHtml("workbench.noMatchingProjects", undefined, t)}</h2><p>${messageHtml("workbench.createYourFirstProjectExistingSessionsAreAvailableUnderSessions", undefined, t)}</p>${button("common.createProject", "create-project")}</div>`,
    );
  }
  /** @type {Map<string, {search: string; directory: string | undefined}>} */
  const projectSessionFilters = new Map();
  /** @param {string} id */
  function projectSessionFilter(id) {
    let filter = projectSessionFilters.get(id);
    if (!filter) {
      filter = { search: "", directory: undefined };
      projectSessionFilters.set(id, filter);
    }
    return filter;
  }
  function renderProjectSessionResults() {
    const project = allProjects().find((entry) => entry.id === viewState.route.id);
    if (!project) return;
    const filter = projectSessionFilter(project.id);
    setMessageHtml(
      findElement("#projectSessionResults"),
      taskRows(project.threads.filter((session) => sessionMatches(session, filter))),
    );
  }
  /** @param {string} value */
  function searchProjectSessions(value) {
    projectSessionFilter(viewState.route.id).search = value;
    renderProjectSessionResults();
  }
  /** @param {string} value */
  function filterProjectDirectory(value) {
    projectSessionFilter(viewState.route.id).directory = value === "*" ? undefined : value;
    renderProjectSessionResults();
  }
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
    setMessageHtml(
      content,
      heading(
        p.name,
        "common.projectDetails",
        button("common.newSession", "project-new", `data-project-id="${escape(p.id)}"`, true),
        true,
      ) +
        `<div class="wb-project-detail"><span class="project-code" data-i18n-ignore>${escape(p.code)}</span><p data-i18n-ignore>${escape(p.description || t("workbench.noDescription"))}</p><div class="wb-project-actions">${button("common.linkExistingSessions", "project-link", `data-project-id="${escape(p.id)}"`)}${button("common.editProject", "project-edit", `data-project-id="${escape(p.id)}"`)}</div></div><div class="wb-section-heading"><h2>${messageHtml("workbench.projectSessions", undefined, t)}</h2><span>${messageHtml("sessions.count", { count: p.threads.length }, t)}</span></div><div class="wb-filter-row"><input id="projectSessionSearch" type="search" ${messageAttributes("aria-label", "common.searchSessions", undefined, t)} ${messageAttributes("placeholder", "workbench.searchSessions", undefined, t)} value="${escape(filter.search)}"><select id="projectSessionDirectory" ${messageAttributes("aria-label", "sessions.byDirectory", undefined, t)}><option value="*">${messageHtml("sessions.allDirectories", undefined, t)}</option>${directories.map((path) => `<option value="${escape(path)}" title="${escape(path)}" ${path === filter.directory ? "selected" : ""}>${escape(path || t("common.noWorkingFolder"))}</option>`).join("")}</select></div><div id="projectSessionResults"></div>`,
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
    renderHome,
    renderTasks,
    renderTaskResults,
    projectCard,
    renderProjects,
    renderProjectResults,
    renderProject,
    renderProjectSessionResults,
    searchProjectSessions,
    filterProjectDirectory,
    renderConnections,
    renderDeliverables,
  };
}
