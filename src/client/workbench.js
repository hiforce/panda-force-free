import {
  localizeAttribute,
  localizeText,
  messageAttributes,
  messageHtml,
  setMessageHtml,
  setOpaqueText,
} from "./i18n.js";

import { parseWorkbenchRoute } from "./workbench-route.js";
export { parseWorkbenchRoute } from "./workbench-route.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import { createProjectDialogs } from "./project-dialogs.js";
import { codexIcon } from "./codex-icons.js";
import { applyThemePreference } from "./theme.js";

const INTRO_KEY = "panda-force-introduction-dismissed";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

export function createWorkbench({
  state,
  t,
  i18n,
  preparation,
  openThread,
  newTask,
  chooseFolder,
  chooseProject,
  setProjectless,
  showSettings,
  catalog,
  setProjectHidden,
  toggleProjectPinned,
  isProjectPinned,
  taskStatus,
  hasPendingApproval,
  closeSidebar,
  openFiles,
}) {
  const shell = document.querySelector(".conversation-shell"),
    viewport = document.querySelector(".conversation-viewport"),
    dock = document.querySelector(".composer-dock"),
    picker = document.querySelector("#conversationProjectPicker");
  const view = document.createElement("section");
  view.id = "workbenchView";
  view.className = "workbench-view";
  setMessageHtml(
    view,
    '<div id="workbenchHero"></div><div id="workbenchComposerSlot"></div><div id="workbenchContent"></div>',
  );
  shell.prepend(view);
  const content = view.querySelector("#workbenchContent"),
    hero = view.querySelector("#workbenchHero"),
    slot = view.querySelector("#workbenchComposerSlot");
  const navigation = document.createElement("nav");
  navigation.className = "workbench-navigation";
  localizeAttribute(navigation, "aria-label", "workbench.workspaceNavigation", undefined, t);
  document.querySelector(".sidebar-top").append(navigation);
  const connection = document.createElement("button");
  connection.type = "button";
  connection.className = "workbench-connection";
  connection.id = "workbenchConnection";
  document.querySelector(".sidebar-footer").prepend(connection);
  const top = document.createElement("div");
  top.className = "workbench-top-tools";
  setMessageHtml(
    top,
    '<button type="button" data-wb="search" aria-label="Search anything" data-pf-aria-label="common.searchAnything">' +
      codexIcon("search") +
      '<span></span><kbd>⌘ K</kbd></button><button type="button" data-wb="theme" aria-label="Toggle theme" data-pf-aria-label="common.toggleTheme">' +
      codexIcon("monitor") +
      "</button>",
  );
  document.querySelector(".top-actions").prepend(top);
  const bottom = document.createElement("nav");
  bottom.className = "workbench-mobile-nav";
  localizeAttribute(bottom, "aria-label", "workbench.workspaceNavigation", undefined, t);
  document.querySelector("#app").append(bottom);
  const dialog = document.createElement("dialog");
  dialog.id = "workbenchDialog";
  dialog.className = "workbench-dialog";
  document.body.append(dialog);
  const progress = document.createElement("button");
  progress.type = "button";
  progress.className = "workbench-preparation";
  progress.id = "workbenchPreparation";
  progress.hidden = true;
  document.querySelector(".sidebar-footer").prepend(progress);
  let route = parseWorkbenchRoute(),
    routing = false,
    opening = "",
    unavailableId = "",
    signature = "",
    query = "",
    projectQuery = "",
    filter = "all",
    scheduled = false,
    knownPreparation = null,
    returnFocus;
  const projectDialogs = createProjectDialogs({
    catalog,
    t,
    onSaved: (project) => navigate("/project?id=" + encodeURIComponent(project.id)),
    onAssigned: () => refresh(),
  });
  const projectContext = document.createElement("div");
  projectContext.id = "businessProjectContext";
  projectContext.className = "business-project-context";
  let contextSignature = "";
  function renderProjectContext() {
    const selected = state.active
      ? catalog.projectForSession(state.active.id)?.id || ""
      : state.newSessionProjectId || "";
    const key = JSON.stringify([
      state.active?.id,
      selected,
      catalog.ready,
      catalog.projects().map((p) => [p.id, p.name, p.code]),
    ]);
    if (key !== contextSignature) {
      contextSignature = key;
      const project = catalog.get(selected);
      setMessageHtml(
        projectContext,
        `<span>${messageHtml("common.project", undefined, t)}</span>${
          state.active
            ? `<strong data-i18n-ignore>${escape(project?.name || t("common.unassigned"))}</strong>${button("common.changeProject", "session-project", 'data-id="' + escape(state.active.id) + '"')}`
            : `<select id="sessionProjectSelect" ${messageAttributes("aria-label", "common.project", undefined, t)} ${catalog.ready ? "" : "disabled"}><option value="" data-pf-message="common.unassigned">${escape(t("common.unassigned"))}</option>${catalog
                .projects()
                .map(
                  (p) =>
                    `<option value="${escape(p.id)}" ${p.id === selected ? "selected" : ""}>${escape(p.name)} · ${escape(p.code)}</option>`,
                )
                .join("")}</select>`
        }`,
      );
      projectContext
        .querySelector("select")
        ?.addEventListener("change", (event) => newTask({ projectId: event.target.value || null }));
    }
    projectContext.hidden = !["workspace", "new", "task", "settings"].includes(route.page);
  }
  const labels = {
    workspace: "common.workspace",
    tasks: "common.sessions",
    projects: "common.projects",
    project: "common.projectDetails",
    deliverables: "common.deliverables",
    connections: "common.connections",
    new: "common.newSession",
    task: "common.session",
    settings: "common.settings",
  };
  const iconNames = {
    workspace: "monitor",
    tasks: "list",
    projects: "folderOpen",
    deliverables: "file",
    connections: "wrench",
    settings: "wrench",
  };
  function button(label, action, attrs = "", primary = false) {
    return `<button type="button" class="wb-button${primary ? " primary" : ""}" data-wb="${action}" ${attrs}>${messageHtml(label, undefined, t)}</button>`;
  }
  function name(path) {
    return path.split("/").filter(Boolean).at(-1) || path;
  }
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
        `<div class="wb-filter-row"><input id="wbTaskSearch" type="search" ${messageAttributes("placeholder", "workbench.searchSessions", undefined, t)} ${messageAttributes("aria-label", "common.searchSessions", undefined, t)} value="${escape(query)}"><select id="wbTaskFilter" ${messageAttributes("aria-label", "common.sessionStatus", undefined, t)}>${["all", "common.inProgress", "workbench.needsReview", "common.failed", "common.ready", "sessions.completed"].map((value) => `<option value="${value}" data-pf-message="${value === "all" ? "common.allSessions" : value}" ${value === filter ? "selected" : ""}>${escape(t(value === "all" ? "common.allSessions" : value))}</option>`).join("")}</select></div><div id="wbTaskResults"></div>`,
    );
    renderTaskResults();
  }
  function renderTaskResults() {
    const q = query.trim().toLocaleLowerCase();
    setMessageHtml(
      document.querySelector("#wbTaskResults"),
      taskRows(
        visibleThreads().filter(
          (x) =>
            (filter === "all" || status(x) === filter) &&
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
        `<div class="wb-filter-row"><input id="wbProjectSearch" type="search" ${messageAttributes("aria-label", "workbench.searchProjects", undefined, t)} ${messageAttributes("placeholder", "workbench.searchProjects2", undefined, t)} value="${escape(projectQuery)}"></div><div class="wb-project-grid" id="wbProjectResults"></div>`,
    );
    renderProjectResults();
  }
  function renderProjectResults() {
    const list = allProjects().filter((p) =>
      [p.name, p.code, p.description].join(" ").toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase()),
    );
    setMessageHtml(
      document.querySelector("#wbProjectResults"),
      !catalog.ready
        ? `<p>${messageHtml("common.loadingProjects2", undefined, t)}</p>`
        : list.length
          ? list.map(projectCard).join("")
          : `<div class="wb-empty"><h2>${messageHtml("workbench.noMatchingProjects", undefined, t)}</h2><p>${messageHtml("workbench.createYourFirstProjectExistingSessionsAreAvailableUnderSessions", undefined, t)}</p>${button("common.createProject", "create-project")}</div>`,
    );
  }
  function renderProject() {
    const p = allProjects().find((p) => p.id === route.id);
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
    setMessageHtml(
      content,
      heading(
        p.name,
        "common.projectDetails",
        button("common.newSession", "project-new", `data-project-id="${escape(p.id)}"`, true),
        true,
      ) +
        `<div class="wb-project-detail"><span class="project-code" data-i18n-ignore>${escape(p.code)}</span><p data-i18n-ignore>${escape(p.description || t("workbench.noDescription"))}</p><div class="wb-project-actions">${button("common.linkExistingSessions", "project-link", `data-project-id="${escape(p.id)}"`)}${button("common.editProject", "project-edit", `data-project-id="${escape(p.id)}"`)}</div></div><div class="wb-section-heading"><h2>${messageHtml("workbench.projectSessions", undefined, t)}</h2><span>${messageHtml("sessions.count", { count: p.threads.length }, t)}</span></div>${taskRows(p.threads)}`,
    );
  }
  function renderConnections() {
    setMessageHtml(
      content,
      heading("common.connections", "common.yourToolsWithClearCapabilitiesAndConnectionStatus") +
        `<div class="wb-project-grid"><article class="wb-card"><div class="wb-section-heading"><h2>Codex</h2><span class="wb-status">${messageHtml(state.connected ? "common.connected" : "common.disconnected", undefined, t)}</span></div><p>${messageHtml("workbench.yourCurrentExecutionEngineModelAuthenticationIsSeparateFromYour", undefined, t)}</p>${button("common.modelAndPermissions", "settings", 'data-page="agent"')}${button("common.usage", "settings", 'data-page="usage"')}</article></div>`,
    );
  }
  function renderDeliverables() {
    setMessageHtml(
      content,
      heading("common.deliverables", "common.inspectFilesInTheirTaskContext") +
        `<div class="wb-card"><h2>${messageHtml("workbench.filesFromYourSessions", undefined, t)}</h2><p>${messageHtml("workbench.openASessionToBrowseAndPreviewFilesFromIts", undefined, t)}</p>${button("common.browseSessionFiles", "files")}${button("common.sessions", "route", 'data-route="tasks"')}</div>`,
    );
  }
  function render() {
    const focused = view.contains(document.activeElement) ? document.activeElement : null,
      focusedId = focused?.id,
      caret = focused?.selectionStart;
    const conversation =
      !(unavailableId && unavailableId === route.id) &&
      (route.page === "new" || route.page === "task" || route.page === "settings");
    document.body.dataset.workbenchPage = route.page;
    document.title = `PandaForce · ${t(labels[route.page] || "common.workspace")}`;
    view.hidden = conversation;
    viewport.hidden = !conversation;
    dock.hidden = !conversation && route.page !== "workspace";
    picker.hidden = Boolean(state.active) || (!conversation && route.page !== "workspace");
    if (route.page === "workspace") {
      for (const element of [projectContext, picker, dock]) if (element.parentNode !== slot) slot.append(element);
      renderHome();
    } else {
      if (picker.parentNode !== shell) shell.insertBefore(picker, viewport);
      if (projectContext.parentNode !== shell) shell.insertBefore(projectContext, picker);
      if (dock.parentNode !== shell) shell.append(dock);
      setMessageHtml(hero, "");
      if (!conversation) {
        if (route.page === "task") {
          setMessageHtml(
            content,
            heading(
              "common.sessionUnavailable",
              "common.returnToSessionsOrRetryThisSession",
              button("common.sessions", "route", 'data-route="tasks"'),
            ) + button("common.retrySession", "task", `data-id="${escape(route.id)}"`),
          );
        } else if (route.page === "tasks") renderTasks();
        else if (route.page === "projects") renderProjects();
        else if (route.page === "project") renderProject();
        else if (route.page === "connections") renderConnections();
        else renderDeliverables();
      }
    }
    const nav = [
      ["workspace", "common.workspace"],
      ["tasks", "common.sessions"],
      ["projects", "common.projects"],
      ["deliverables", "common.deliverables"],
      ["connections", "common.connections"],
      ["settings", "common.settings"],
    ];
    setMessageHtml(
      navigation,
      nav
        .map(
          ([key, label]) =>
            `<button type="button" data-wb="route" data-route="${key}" class="${route.page === key || (key === "projects" && route.page === "project") || (key === "tasks" && route.page === "task") ? "active" : ""}" ${route.page === key ? 'aria-current="page"' : ""}><span class="icon-slot">${codexIcon(iconNames[key])}</span><span>${messageHtml(label, undefined, t)}</span></button>`,
        )
        .join(""),
    );
    setMessageHtml(
      bottom,
      nav
        .filter(([key]) => ["workspace", "tasks", "projects", "settings"].includes(key))
        .map(
          ([key, label]) =>
            `<button type="button" data-wb="route" data-route="${key}" class="${route.page === key ? "active" : ""}"><span>${codexIcon(iconNames[key])}</span>${messageHtml(label, undefined, t)}</button>`,
        )
        .join(""),
    );
    setMessageHtml(
      connection,
      `<span class="status-dot ${state.connected ? "connected" : "error"}"></span><span>${messageHtml(state.connected ? "common.codexConnected" : "auth.connectionUnavailable", undefined, t)}</span>`,
    );
    localizeText(top.querySelector("button span"), "common.searchAnything", undefined, t);
    localizeAttribute(top.querySelector('[data-wb="search"]'), "aria-label", "common.searchAnything", undefined, t);
    if (!conversation)
      localizeText(document.querySelector("#threadTitle"), labels[route.page] || "common.workspace", undefined, t);
    if (!conversation) setOpaqueText(document.querySelector("#threadPath"), "");
    renderProjectContext();
    renderPreparation();
    const nextFocus = focusedId && document.getElementById(focusedId);
    if (nextFocus && nextFocus !== focused) {
      nextFocus.focus({ preventScroll: true });
      if (typeof caret === "number")
        try {
          nextFocus.setSelectionRange(caret, caret);
        } catch {}
    }
  }
  function renderPreparation() {
    const snapshot = knownPreparation;
    if (!snapshot) return;
    const ready = snapshot.steps.filter((x) => x.status === "ready").length;
    progress.hidden = ready === snapshot.steps.length;
    setMessageHtml(
      progress,
      `<span>${messageHtml("workbench.workspacePreparation", undefined, t)} · ${ready}/${snapshot.steps.length}</span><progress max="${snapshot.steps.length}" value="${ready}"></progress>`,
    );
  }
  function updateUrl(path, replace = false) {
    if (location.pathname + location.search !== path)
      history[replace ? "replaceState" : "pushState"]({ pandaForce: true }, "", path);
  }
  function navigate(path, { replace = false } = {}) {
    const url = new URL(path.startsWith("/") ? path : "/" + path, location.origin);
    if (url.origin !== location.origin) return;
    const next = parseWorkbenchRoute(url);
    routing = true;
    unavailableId = "";
    if (next.page === "workspace" && state.active) newTask();
    if (next.page !== "settings") updateUrl(url.pathname + url.search, replace);
    route = next;
    signature = "";
    closeSidebar();
    render();
    if (next.page === "settings") showSettings(next.id || "general-settings");
    if (next.page === "task") loadRouteTask();
    routing = false;
  }
  function loadRouteTask() {
    if (
      route.page !== "task" ||
      !route.id ||
      state.active?.id === route.id ||
      !state.connected ||
      !state.config.home ||
      opening === route.id ||
      unavailableId === route.id
    )
      return;
    const id = route.id;
    opening = id;
    void openThread(id)
      .then((ok) => {
        if (
          !ok &&
          route.page === "task" &&
          route.id === id &&
          (state.active?.id !== id || !state.active?.turns?.length)
        ) {
          unavailableId = id;
          render();
        }
      })
      .finally(() => {
        if (opening === id) opening = "";
      });
  }
  function threadOpened(id) {
    if (routing && route.page !== "task") return;
    route = { page: "task", id, cwd: "" };
    updateUrl("/task/" + encodeURIComponent(id));
    render();
  }
  function taskStarted() {
    if (routing) return;
    route = { page: "new", id: "", cwd: "" };
    updateUrl("/new" + (state.newSessionProjectId ? "?project=" + encodeURIComponent(state.newSessionProjectId) : ""));
    render();
  }
  function refresh() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      // A slower cached/history read may recover after an earlier startup read was superseded.
      if (unavailableId === state.active?.id && state.active?.turns?.length) {
        unavailableId = "";
        signature = "";
      }
      if (state.active && ["workspace", "new"].includes(route.page)) threadOpened(state.active.id);
      loadRouteTask();
      const next = JSON.stringify([
        route,
        state.connected,
        state.threads.map((x) => [x.id, x.name, x.preview, x.cwd, x.status, x.turns?.at(-1)?.status, status(x)]),
        catalog.revision,
        state.newSessionProjectId,
        state.workspaceContext?.cwd,
      ]);
      if (next !== signature) {
        signature = next;
        render();
      }
    });
  }
  function modal(title, body) {
    returnFocus = document.activeElement;
    setMessageHtml(
      dialog,
      `<header><h2>${messageHtml(title, undefined, t)}</h2>${button("common.close", "close")}</header>${body}`,
    );
    if (!dialog.open) dialog.showModal();
  }
  function commandResults(value = "") {
    const q = value.toLocaleLowerCase();
    const list = [
      ...["workspace", "tasks", "projects", "deliverables", "connections", "settings"].map((page) => ({
        label: t(labels[page]),
        action: "route",
        attrs: `data-route="${page}"`,
      })),
      ...visibleThreads()
        .slice(0, 1000)
        .map((x) => ({
          label: x.name || x.preview || t("workbench.untitledSession"),
          action: "task",
          attrs: `data-id="${escape(x.id)}"`,
        })),
      ...allProjects().map((p) => ({
        label: p.name + " · " + p.code,
        action: "project",
        attrs: `data-project-id="${escape(p.id)}"`,
      })),
    ]
      .filter((x) => x.label.toLocaleLowerCase().includes(q))
      .slice(0, 30);
    setMessageHtml(
      dialog.querySelector("#wbCommandResults"),
      list.length
        ? list
            .map(
              (x) =>
                `<button type="button" data-i18n-ignore data-wb="${x.action}" ${x.attrs}>${escape(x.label)}</button>`,
            )
            .join("")
        : `<p>${messageHtml("common.noResultsFound", undefined, t)}</p>`,
    );
  }
  function openSearch() {
    modal(
      "common.searchAnything",
      `<p class="wb-keyboard-tip">${messageHtml("workbench.ctrlCmdKSearchesCtrlCmdShiftKCreatesA", undefined, t)}</p><input id="wbCommandQuery" type="search" autocomplete="off" ${messageAttributes("aria-label", "common.searchAnything", undefined, t)}><div id="wbCommandResults"></div>`,
    );
    commandResults();
    dialog.querySelector("input").oninput = (e) => commandResults(e.target.value);
    dialog.querySelector("input").onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        const first = dialog.querySelector("#wbCommandResults button");
        if (first) {
          e.preventDefault();
          if (e.key === "Enter") first.click();
          else first.focus();
        }
      }
    };
    dialog.querySelector("input").focus();
  }
  async function action(event) {
    const el = event.target.closest("[data-wb]");
    if (!el) return;
    const what = el.dataset.wb;
    if (dialog.open && what !== "close") dialog.close();
    if (what === "close") {
      dialog.close();
      return;
    }
    if (what === "route") {
      navigate(el.dataset.route);
      return;
    }
    if (what === "new") {
      newTask();
      return;
    }
    if (what === "task") {
      navigate("/task/" + encodeURIComponent(el.dataset.id));
      return;
    }
    if (what === "project") {
      navigate("/project?id=" + encodeURIComponent(el.dataset.projectId));
      return;
    }
    if (what === "create-project") {
      await projectDialogs.edit();
      return;
    }
    if (what === "project-edit") {
      await projectDialogs.edit(catalog.get(el.dataset.projectId));
      return;
    }
    if (what === "project-link") {
      await projectDialogs.associate(el.dataset.projectId);
      return;
    }
    if (what === "session-project") {
      await associateSession(el.dataset.id);
      return;
    }
    if (what === "project-new") {
      newTask({ projectId: el.dataset.projectId });
      return;
    }
    if (what === "folder") {
      chooseFolder();
      return;
    }
    if (what === "settings") {
      navigate("/settings/" + (el.dataset.page || "general-settings"));
      return;
    }
    if (what === "search") {
      openSearch();
      return;
    }
    if (what === "theme") {
      applyThemePreference(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
      return;
    }
    if (what === "template") {
      if (state.active) newTask();
      document.querySelector("#prompt").value = t(el.dataset.template);
      document.querySelector("#prompt").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#prompt").focus();
      return;
    }
    if (what === "running" || what === "review") {
      filter = what === "running" ? "common.inProgress" : "workbench.needsReview";
      navigate("tasks");
      return;
    }
    if (what === "dismiss-intro") {
      storage.set(INTRO_KEY, "1");
      render();
      return;
    }
    if (what === "files") {
      openFiles();
      return;
    }
    if (what === "pin") {
      toggleProjectPinned("project:" + el.dataset.projectId);
      refresh();
      return;
    }
  }
  document.addEventListener("click", (event) => {
    void action(event).catch((error) =>
      modal("errors.couldNotCompleteAction", `<p role="alert">${escape(error.message)}</p>`),
    );
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "wbTaskSearch") {
      query = event.target.value;
      renderTaskResults();
    }
    if (event.target.id === "wbProjectSearch") {
      projectQuery = event.target.value;
      renderProjectResults();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "wbTaskFilter") {
      filter = event.target.value;
      renderTaskResults();
    }
  });
  connection.onclick = () =>
    modal(
      "common.connectionStatus",
      `<p>${messageHtml(state.connected ? "common.codexConnected" : "auth.connectionUnavailable", undefined, t)}</p><p>${messageHtml("common.yourPandaforceAccountIsSeparateFromYourCodexAccount", undefined, t)}</p><p>${messageHtml("workbench.loadedSessions", undefined, t)}: ${state.threads.length}</p>${button("common.retryWorkspaceReads", "retry")}`,
    );
  dialog.addEventListener("close", () => {
    if (returnFocus?.isConnected) returnFocus.focus();
    else document.querySelector("#newTask")?.focus();
  });
  dialog.addEventListener("keydown", (e) => {
    const buttons = [...dialog.querySelectorAll("#wbCommandResults button")],
      index = buttons.indexOf(document.activeElement);
    if (index >= 0 && ["ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowUp" && index === 0) dialog.querySelector("#wbCommandQuery").focus();
      else buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  });
  progress.onclick = () => {
    const snapshot = knownPreparation;
    modal(
      "workbench.workspacePreparation",
      `<ol class="wb-preparation-list">${snapshot.steps.map((s) => `<li>${messageHtml(s.label, undefined, t)}<strong>${messageHtml(s.status, undefined, t)}</strong></li>`).join("")}</ol>${button("common.retryWorkspaceReads", "retry")}`,
    );
  };
  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-wb="retry"]')) preparation.retry();
  });
  window.addEventListener("popstate", () => {
    route = parseWorkbenchRoute();
    routing = true;
    if (route.page === "workspace" && state.active) newTask();
    routing = false;
    unavailableId = "";
    signature = "";
    render();
    loadRouteTask();
  });
  i18n.subscribe(() => {
    // Bindings update owned copy in place, preserving search focus and selection.
    document.title = `PandaForce · ${t(labels[route.page] || "common.workspace")}`;
    i18n.bindings.refresh();
  });
  preparation.subscribe((snapshot) => {
    knownPreparation = snapshot;
    renderPreparation();
  });
  function rememberProject() {
    refresh();
  }
  function associateSession(id) {
    return projectDialogs.associate(catalog.projectForSession(id)?.id || null, [id]);
  }
  function keyboard(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) newTask();
      else openSearch();
      return true;
    }
    return false;
  }
  if (location.pathname !== "/" && ["workspace", "new"].includes(route.page)) {
    routing = true;
    newTask();
    routing = false;
  }
  render();
  return {
    refresh,
    navigate,
    threadOpened,
    taskStarted,
    rememberProject,
    associateSession,
    openSearch,
    keyboard,
    get route() {
      return route;
    },
  };
}
