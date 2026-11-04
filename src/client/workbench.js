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
const routes = new Set(["workspace", "tasks", "projects", "project", "deliverables", "connections", "new", "task"]);
export function parseWorkbenchRoute(url = new URL(location.href)) {
  const parts = url.pathname.split("/").filter(Boolean);
  const page = parts[0] === "settings" ? "settings" : routes.has(parts[0]) ? parts[0] : "workspace";
  let id = "";
  try {
    id = decodeURIComponent(parts[1] || "");
  } catch {
    /* Invalid identifiers are handled as unavailable tasks. */
  }
  return {
    page,
    id: page === "project" ? url.searchParams.get("id") || "" : id,
    projectId: url.searchParams.get("project") || "",
  };
}
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
  view.innerHTML =
    '<div id="workbenchHero"></div><div id="workbenchComposerSlot"></div><div id="workbenchContent"></div>';
  shell.prepend(view);
  const content = view.querySelector("#workbenchContent"),
    hero = view.querySelector("#workbenchHero"),
    slot = view.querySelector("#workbenchComposerSlot");
  const navigation = document.createElement("nav");
  navigation.className = "workbench-navigation";
  navigation.setAttribute("aria-label", t("Workspace navigation"));
  document.querySelector(".sidebar-top").append(navigation);
  const connection = document.createElement("button");
  connection.type = "button";
  connection.className = "workbench-connection";
  connection.id = "workbenchConnection";
  document.querySelector(".sidebar-footer").prepend(connection);
  const top = document.createElement("div");
  top.className = "workbench-top-tools";
  top.innerHTML =
    '<button type="button" data-wb="search" aria-label="Search anything">' +
    codexIcon("search") +
    '<span></span><kbd>⌘ K</kbd></button><button type="button" data-wb="theme" aria-label="Toggle theme">' +
    codexIcon("monitor") +
    "</button>";
  document.querySelector(".top-actions").prepend(top);
  const bottom = document.createElement("nav");
  bottom.className = "workbench-mobile-nav";
  bottom.setAttribute("aria-label", t("Workspace navigation"));
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
      i18n.locale,
      catalog.projects().map((p) => [p.id, p.name, p.code]),
    ]);
    if (key !== contextSignature) {
      contextSignature = key;
      const project = catalog.get(selected);
      projectContext.innerHTML = `<span>${escape(t("Project"))}</span>${
        state.active
          ? `<strong data-i18n-ignore>${escape(project?.name || t("Unassigned"))}</strong>${button("Change project", "session-project", 'data-id="' + escape(state.active.id) + '"')}`
          : `<select id="sessionProjectSelect" aria-label="${escape(t("Project"))}" ${catalog.ready ? "" : "disabled"}><option value="">${escape(t("Unassigned"))}</option>${catalog
              .projects()
              .map(
                (p) =>
                  `<option value="${escape(p.id)}" ${p.id === selected ? "selected" : ""}>${escape(p.name)} · ${escape(p.code)}</option>`,
              )
              .join("")}</select>`
      }`;
      projectContext
        .querySelector("select")
        ?.addEventListener("change", (event) => newTask({ projectId: event.target.value || null }));
    }
    projectContext.hidden = !["workspace", "new", "task", "settings"].includes(route.page);
  }
  const labels = {
    workspace: "Workspace",
    tasks: "Sessions",
    projects: "Projects",
    project: "Project details",
    deliverables: "Deliverables",
    connections: "Connections",
    new: "New session",
    task: "Session",
    settings: "Settings",
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
    return `<button type="button" class="wb-button${primary ? " primary" : ""}" data-wb="${action}" ${attrs}>${escape(t(label))}</button>`;
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
      return "Needs review";
    if (actual?.state === "running" || thread.status?.type === "active") return "In progress";
    if (actual?.state === "error" || thread.status?.type === "systemError") return "Failed";
    return actual?.state === "completed" ? "Completed" : "Ready";
  }
  function taskRows(list) {
    if (!list.length)
      return `<div class="wb-empty"><strong>${escape(t("No sessions found"))}</strong><p>${escape(t("Create a session or change your filters to get started."))}</p>${button("New session", "new", "", true)}</div>`;
    return `<div class="wb-task-list">${list
      .slice(0, 100)
      .map((thread) => {
        const project = catalog.projectForSession(thread.id);
        return `<div class="wb-session-entry"><button type="button" class="wb-task-row" data-wb="task" data-id="${escape(thread.id)}"><span class="wb-task-icon">${codexIcon("messageSquare")}</span><span class="wb-task-copy" data-i18n-ignore><strong>${escape((thread.name || thread.preview || t("Untitled session")).replace(/\s+/g, " ").slice(0, 110))}</strong><small>${escape(project?.name || t("Unassigned"))} · ${escape(thread.cwd || t("No working folder"))}</small></span><span class="wb-status ${status(thread) === "In progress" ? "running" : status(thread) === "Needs review" ? "review" : ""}">${escape(t(status(thread)))}</span></button><button type="button" class="icon-button wb-session-association" data-wb="session-project" data-id="${escape(thread.id)}" aria-label="${escape(t("Change project"))}" title="${escape(t("Change project"))}">${codexIcon("ellipsis")}</button></div>`;
      })
      .join(
        "",
      )}</div>${list.length > 100 ? `<p class="wb-list-limit">${escape(t("Showing the first 100 matches. Refine your search to find another session."))}</p>` : ""}`;
  }
  function heading(title, description, action = "", userTitle = false) {
    return `<header class="wb-page-heading"><div><h1${userTitle ? " data-i18n-ignore" : ""}>${escape(userTitle ? title : t(title))}</h1><p>${escape(t(description))}</p></div>${action}</header>`;
  }
  function renderHome() {
    hero.innerHTML = `<div class="wb-hero"><p class="wb-eyebrow">${escape(t("Your next move"))}</p><h1>${escape(t("What would you like to get done?"))}</h1><p>${escape(t("Start with a goal. Stay in control, and review the result in one place."))}</p></div>`;
    const threads = visibleThreads();
    content.innerHTML = `<div class="wb-quick-actions">${["Review a project", "Prepare a plan", "Explain this project"].map((label) => button(label, "template", `data-template="${escape(label)}"`)).join("")}</div><div class="wb-metrics"><button data-wb="running"><strong>${threads.filter((x) => status(x) === "In progress").length}</strong><span>${escape(t("In progress"))}</span></button><button data-wb="review"><strong>${threads.filter((x) => status(x) === "Needs review").length}</strong><span>${escape(t("Needs review"))}</span></button><button data-wb="route" data-route="projects"><strong>${allProjects().length}</strong><span>${escape(t("Projects"))}</span></button></div>${!storage.get(INTRO_KEY) ? `<aside class="wb-introduction"><div><strong>${escape(t("From a goal to a result"))}</strong><p>${escape(t("Choose a project to organize sessions. Select a working folder separately when you need one."))}</p></div>${button("Got it", "dismiss-intro")}</aside>` : ""}<div class="wb-section-heading"><h2>${escape(t("Recent sessions"))}</h2>${button("View all sessions", "route", 'data-route="tasks"')}</div>${taskRows(threads.slice(0, 8))}`;
  }
  function renderTasks() {
    content.innerHTML =
      heading("Sessions", "Browse sessions and their project associations.", button("New session", "new", "", true)) +
      `<div class="wb-filter-row"><input id="wbTaskSearch" type="search" placeholder="${escape(t("Search sessions…"))}" aria-label="${escape(t("Search sessions"))}" value="${escape(query)}"><select id="wbTaskFilter" aria-label="${escape(t("Session status"))}">${["all", "In progress", "Needs review", "Failed", "Ready", "Completed"].map((value) => `<option value="${value}" ${value === filter ? "selected" : ""}>${escape(t(value === "all" ? "All sessions" : value))}</option>`).join("")}</select></div><div id="wbTaskResults"></div>`;
    renderTaskResults();
  }
  function renderTaskResults() {
    const q = query.trim().toLocaleLowerCase();
    document.querySelector("#wbTaskResults").innerHTML = taskRows(
      visibleThreads().filter(
        (x) =>
          (filter === "all" || status(x) === filter) &&
          [x.name, x.preview, x.cwd, catalog.projectForSession(x.id)?.name, catalog.projectForSession(x.id)?.code]
            .join(" ")
            .toLocaleLowerCase()
            .includes(q),
      ),
    );
  }
  function projectCard(p) {
    return `<article class="wb-project"><button class="wb-project-main" data-i18n-ignore data-wb="project" data-project-id="${escape(p.id)}"><span>${codexIcon("folderOpen")}</span><strong>${escape(p.name)}</strong><small class="project-code">${escape(p.code)}</small><p class="project-description">${escape(p.description || "")}</p><small>${p.threads.length} ${escape(t("sessions"))}</small></button><div class="wb-project-actions">${button("New session", "project-new", `data-project-id="${escape(p.id)}"`)}${button(isProjectPinned("project:" + p.id) ? "Unpin" : "Pin", "pin", `data-project-id="${escape(p.id)}"`)}</div></article>`;
  }
  function renderProjects() {
    content.innerHTML =
      heading(
        "Projects",
        "Create projects and organize their sessions.",
        button("Create project", "create-project", "", true),
      ) +
      `<div class="wb-filter-row"><input id="wbProjectSearch" type="search" aria-label="${escape(t("Search projects"))}" placeholder="${escape(t("Search projects…"))}" value="${escape(projectQuery)}"></div><div class="wb-project-grid" id="wbProjectResults"></div>`;
    renderProjectResults();
  }
  function renderProjectResults() {
    const list = allProjects().filter((p) =>
      [p.name, p.code, p.description].join(" ").toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase()),
    );
    document.querySelector("#wbProjectResults").innerHTML = !catalog.ready
      ? `<p>${escape(t("Loading projects…"))}</p>`
      : list.length
        ? list.map(projectCard).join("")
        : `<div class="wb-empty"><h2>${escape(t("No matching projects"))}</h2><p>${escape(t("Create your first project. Existing sessions are available under Sessions."))}</p>${button("Create project", "create-project")}</div>`;
  }
  function renderProject() {
    const p = allProjects().find((p) => p.id === route.id);
    if (!p) {
      content.innerHTML = heading(
        catalog.ready ? "Project unavailable" : "Loading projects…",
        "Choose a project to continue.",
        button("Projects", "route", 'data-route="projects"'),
      );
      return;
    }
    content.innerHTML =
      heading(
        p.name,
        "Project details",
        button("New session", "project-new", `data-project-id="${escape(p.id)}"`, true),
        true,
      ) +
      `<div class="wb-project-detail"><span class="project-code" data-i18n-ignore>${escape(p.code)}</span><p data-i18n-ignore>${escape(p.description || t("No description"))}</p><div class="wb-project-actions">${button("Link existing sessions", "project-link", `data-project-id="${escape(p.id)}"`)}${button("Edit project", "project-edit", `data-project-id="${escape(p.id)}"`)}</div></div><div class="wb-section-heading"><h2>${escape(t("Project sessions"))}</h2><span>${p.threads.length} ${escape(t("sessions"))}</span></div>${taskRows(p.threads)}`;
  }
  function renderConnections() {
    content.innerHTML =
      heading("Connections", "Your tools, with clear capabilities and connection status.") +
      `<div class="wb-project-grid"><article class="wb-card"><div class="wb-section-heading"><h2>Codex</h2><span class="wb-status">${escape(t(state.connected ? "Connected" : "Disconnected"))}</span></div><p>${escape(t("Your current execution engine. Model authentication is separate from your PandaForce sign-in."))}</p>${button("Model and permissions", "settings", 'data-page="agent"')}${button("Usage", "settings", 'data-page="usage"')}</article></div>`;
  }
  function renderDeliverables() {
    content.innerHTML =
      heading("Deliverables", "Inspect files in their task context.") +
      `<div class="wb-card"><h2>${escape(t("Files from your sessions"))}</h2><p>${escape(t("Open a session to browse and preview files from its working folder."))}</p>${button("Browse session files", "files")}${button("Sessions", "route", 'data-route="tasks"')}</div>`;
  }
  function render() {
    const focused = view.contains(document.activeElement) ? document.activeElement : null,
      focusedId = focused?.id,
      caret = focused?.selectionStart;
    const conversation =
      !(unavailableId && unavailableId === route.id) &&
      (route.page === "new" || route.page === "task" || route.page === "settings");
    document.body.dataset.workbenchPage = route.page;
    document.title = `PandaForce · ${t(labels[route.page] || "Workspace")}`;
    view.hidden = conversation;
    viewport.hidden = !conversation;
    dock.hidden = !conversation && route.page !== "workspace";
    picker.hidden = Boolean(state.active) || (!conversation && route.page !== "workspace");
    if (route.page === "workspace") {
      for (const element of [projectContext, picker, dock])
        if (element.parentNode !== slot) slot.append(element);
      renderHome();
    } else {
      if (picker.parentNode !== shell) shell.insertBefore(picker, viewport);
      if (projectContext.parentNode !== shell) shell.insertBefore(projectContext, picker);
      if (dock.parentNode !== shell) shell.append(dock);
      hero.innerHTML = "";
      if (!conversation) {
        if (route.page === "task") {
          content.innerHTML =
            heading(
              "Session unavailable",
              "Return to sessions or retry this session.",
              button("Sessions", "route", 'data-route="tasks"'),
            ) + button("Retry session", "task", `data-id="${escape(route.id)}"`);
        } else if (route.page === "tasks") renderTasks();
        else if (route.page === "projects") renderProjects();
        else if (route.page === "project") renderProject();
        else if (route.page === "connections") renderConnections();
        else renderDeliverables();
      }
    }
    const nav = [
      ["workspace", "Workspace"],
      ["tasks", "Sessions"],
      ["projects", "Projects"],
      ["deliverables", "Deliverables"],
      ["connections", "Connections"],
      ["settings", "Settings"],
    ];
    navigation.innerHTML = nav
      .map(
        ([key, label]) =>
          `<button type="button" data-wb="route" data-route="${key}" class="${route.page === key || (key === "projects" && route.page === "project") || (key === "tasks" && route.page === "task") ? "active" : ""}" ${route.page === key ? 'aria-current="page"' : ""}><span class="icon-slot">${codexIcon(iconNames[key])}</span><span>${escape(t(label))}</span></button>`,
      )
      .join("");
    bottom.innerHTML = nav
      .filter(([key]) => ["workspace", "tasks", "projects", "settings"].includes(key))
      .map(
        ([key, label]) =>
          `<button type="button" data-wb="route" data-route="${key}" class="${route.page === key ? "active" : ""}"><span>${codexIcon(iconNames[key])}</span>${escape(t(label))}</button>`,
      )
      .join("");
    connection.innerHTML = `<span class="status-dot ${state.connected ? "connected" : "error"}"></span><span>${escape(t(state.connected ? "Codex connected" : "Connection unavailable"))}</span>`;
    top.querySelector("button span").textContent = t("Search anything");
    top.querySelector('[data-wb="search"]').setAttribute("aria-label", t("Search anything"));
    if (!conversation) document.querySelector("#threadTitle").textContent = t(labels[route.page] || "Workspace");
    if (!conversation) document.querySelector("#threadPath").textContent = "";
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
    progress.innerHTML = `<span>${escape(t("Workspace preparation"))} · ${ready}/${snapshot.steps.length}</span><progress max="${snapshot.steps.length}" value="${ready}"></progress>`;
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
      if (state.active && ["workspace", "new"].includes(route.page)) threadOpened(state.active.id);
      loadRouteTask();
      const next = JSON.stringify([
        route,
        state.connected,
        state.threads.map((x) => [x.id, x.name, x.preview, x.cwd, x.status, x.turns?.at(-1)?.status, status(x)]),
        catalog.revision,
        state.newSessionProjectId,
        state.workspaceContext?.cwd,
        i18n.locale,
      ]);
      if (next !== signature) {
        signature = next;
        render();
      }
    });
  }
  function modal(title, body) {
    returnFocus = document.activeElement;
    dialog.innerHTML = `<header><h2>${escape(t(title))}</h2>${button("Close", "close")}</header>${body}`;
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
          label: x.name || x.preview || t("Untitled session"),
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
    dialog.querySelector("#wbCommandResults").innerHTML = list.length
      ? list
          .map(
            (x) =>
              `<button type="button" data-i18n-ignore data-wb="${x.action}" ${x.attrs}>${escape(x.label)}</button>`,
          )
          .join("")
      : `<p>${escape(t("No results found"))}</p>`;
  }
  function openSearch() {
    modal(
      "Search anything",
      `<p class="wb-keyboard-tip">${escape(t("Ctrl/Cmd+K searches. Ctrl/Cmd+Shift+K creates a session."))}</p><input id="wbCommandQuery" type="search" autocomplete="off" aria-label="${escape(t("Search anything"))}"><div id="wbCommandResults"></div>`,
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
      filter = what === "running" ? "In progress" : "Needs review";
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
      modal("Could not complete action", `<p role="alert">${escape(error.message)}</p>`),
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
      "Connection status",
      `<p>${escape(t(state.connected ? "Codex connected" : "Connection unavailable"))}</p><p>${escape(t("Your PandaForce account is separate from your Codex account."))}</p><p>${escape(t("Loaded sessions"))}: ${state.threads.length}</p>${button("Retry workspace reads", "retry")}`,
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
      "Workspace preparation",
      `<ol class="wb-preparation-list">${snapshot.steps.map((s) => `<li>${escape(t(s.label))}<strong>${escape(t(s.status))}</strong></li>`).join("")}</ol>${button("Retry workspace reads", "retry")}`,
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
    signature = "";
    render();
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
