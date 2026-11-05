import { escapeHtml as escape } from "../shared/html.js";
import { closestElement, findElement, findElements, requireElement } from "./dom.js";
import {
  localizeAttribute,
  localizeText,
  messageAttributes,
  messageHtml,
  setMessageHtml,
  setOpaqueText,
} from "./i18n.js";
import { createWorkbenchSearch } from "./workbench-search.js";
import { createWorkbenchViews } from "./workbench-views.js";

import { codexIcon } from "./codex-icons.js";
import { createProjectDialogs } from "./project-dialogs.js";
import { storage } from "./storage.js";
import { applyThemePreference } from "./theme.js";
import { parseWorkbenchRoute } from "./workbench-route.js";
export { parseWorkbenchRoute } from "./workbench-route.js";

const INTRO_KEY = "panda-force-introduction-dismissed";

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
  const shell = requireElement(".conversation-shell"),
    viewport = requireElement(".conversation-viewport"),
    dock = requireElement(".composer-dock"),
    picker = requireElement("#conversationProjectPicker");
  const view = document.createElement("section");
  view.id = "workbenchView";
  view.className = "workbench-view";
  setMessageHtml(
    view,
    '<div id="workbenchHero"></div><div id="workbenchComposerSlot"></div><div id="workbenchContent"></div>',
  );
  shell.prepend(view);
  const content = findElement("#workbenchContent", view),
    hero = findElement("#workbenchHero", view),
    slot = requireElement("#workbenchComposerSlot", view);
  const navigation = document.createElement("nav");
  navigation.className = "workbench-navigation";
  localizeAttribute(navigation, "aria-label", "workbench.workspaceNavigation", undefined, t);
  requireElement(".sidebar-top").append(navigation);
  const connection = document.createElement("button");
  connection.type = "button";
  connection.className = "workbench-connection";
  connection.id = "workbenchConnection";
  requireElement(".sidebar-footer").prepend(connection);
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
  requireElement(".top-actions").prepend(top);
  const bottom = document.createElement("nav");
  bottom.className = "workbench-mobile-nav";
  localizeAttribute(bottom, "aria-label", "workbench.workspaceNavigation", undefined, t);
  requireElement("#app").append(bottom);
  const dialog = document.createElement("dialog");
  dialog.id = "workbenchDialog";
  dialog.className = "workbench-dialog";
  document.body.append(dialog);
  const progress = document.createElement("button");
  progress.type = "button";
  progress.className = "workbench-preparation";
  progress.id = "workbenchPreparation";
  progress.hidden = true;
  requireElement(".sidebar-footer").prepend(progress);
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
      findElement("select", projectContext)?.addEventListener("change", (event) =>
        newTask({ projectId: requireElement("select", projectContext).value || null }),
      );
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
  const {
    button,
    allProjects,
    visibleThreads,
    status,
    heading,
    renderHome,
    renderTasks,
    renderTaskResults,
    renderProjects,
    renderProjectResults,
    renderProject,
    searchProjectSessions,
    filterProjectDirectory,
    renderConnections,
    renderDeliverables,
  } = createWorkbenchViews({
    state,
    t,
    catalog,
    isProjectPinned,
    taskStatus,
    hasPendingApproval,
    content,
    hero,
    INTRO_KEY,
    viewState: {
      get route() {
        return route;
      },
      get query() {
        return query;
      },
      get filter() {
        return filter;
      },
      get projectQuery() {
        return projectQuery;
      },
    },
  });
  function render() {
    const focused = view.contains(document.activeElement) ? document.activeElement : null,
      focusedId = focused?.id,
      caret =
        focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused.selectionStart : null;
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
            `<button type="button" data-wb="route" data-route="${key}" class="${route.page === key || (key === "projects" && route.page === "project") || (key === "tasks" && route.page === "task") ? "active" : ""}"><span class="icon-slot" aria-hidden="true">${codexIcon(iconNames[key])}</span>${messageHtml(label, undefined, t)}</button>`,
        )
        .join(""),
    );
    setMessageHtml(
      connection,
      `<span class="status-dot ${state.connected ? "connected" : "error"}"></span><span>${messageHtml(state.connected ? "common.codexConnected" : "auth.connectionUnavailable", undefined, t)}</span>`,
    );
    localizeText(findElement("button span", top), "common.searchAnything", undefined, t);
    localizeAttribute(findElement('[data-wb="search"]', top), "aria-label", "common.searchAnything", undefined, t);
    if (!conversation)
      localizeText(requireElement("#threadTitle"), labels[route.page] || "common.workspace", undefined, t);
    if (!conversation) setOpaqueText(requireElement("#threadPath"), "");
    renderProjectContext();
    renderPreparation();
    const nextFocus = focusedId && document.getElementById(focusedId);
    if (nextFocus && nextFocus !== focused) {
      nextFocus.focus({ preventScroll: true });
      if (
        typeof caret === "number" &&
        (nextFocus instanceof HTMLInputElement || nextFocus instanceof HTMLTextAreaElement)
      )
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
    route = { page: "task", id, cwd: "", projectId: "" };
    updateUrl("/task/" + encodeURIComponent(id));
    render();
  }
  function taskStarted() {
    if (routing) return;
    route = { page: "new", id: "", cwd: "", projectId: "" };
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
  const { openSearch } = createWorkbenchSearch({ t, dialog, labels, allProjects, visibleThreads, modal });
  const actions = {
    close: async (el, what) => {
      dialog.close();
      return;
    },
    route: async (el, what) => {
      navigate(el.dataset.route);
      return;
    },
    new: async (el, what) => {
      newTask();
      return;
    },
    task: async (el, what) => {
      navigate("/task/" + encodeURIComponent(el.dataset.id));
      return;
    },
    project: async (el, what) => {
      navigate("/project?id=" + encodeURIComponent(el.dataset.projectId));
      return;
    },
    "create-project": async (el, what) => {
      await projectDialogs.edit();
      return;
    },
    "project-edit": async (el, what) => {
      await projectDialogs.edit(catalog.get(el.dataset.projectId));
      return;
    },
    "project-link": async (el, what) => {
      await projectDialogs.associate(el.dataset.projectId);
      return;
    },
    "session-project": async (el, what) => {
      await associateSession(el.dataset.id);
      return;
    },
    "project-new": async (el, what) => {
      newTask({ projectId: el.dataset.projectId });
      return;
    },
    folder: async (el, what) => {
      chooseFolder();
      return;
    },
    settings: async (el, what) => {
      navigate("/settings/" + (el.dataset.page || "general-settings"));
      return;
    },
    search: async (el, what) => {
      openSearch();
      return;
    },
    theme: async (el, what) => {
      applyThemePreference(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
      return;
    },
    template: async (el, what) => {
      if (state.active) newTask();
      requireElement("#prompt").value = t(el.dataset.template);
      requireElement("#prompt").dispatchEvent(new Event("input", { bubbles: true }));
      requireElement("#prompt").focus();
      return;
    },
    running: async (el, what) => {
      filter = what === "running" ? "common.inProgress" : "workbench.needsReview";
      navigate("tasks");
      return;
    },
    review: async (el, what) => {
      filter = what === "running" ? "common.inProgress" : "workbench.needsReview";
      navigate("tasks");
      return;
    },
    "dismiss-intro": async (el, what) => {
      storage.set(INTRO_KEY, "1");
      render();
      return;
    },
    files: async (el, what) => {
      openFiles();
      return;
    },
    pin: async (el, what) => {
      toggleProjectPinned("project:" + el.dataset.projectId);
      refresh();
      return;
    },
  };
  async function action(event) {
    const el = event.target instanceof Element ? closestElement("[data-wb]", event.target) : null;
    if (!el) return;
    const what = el.dataset.wb;
    if (dialog.open && what !== "close") dialog.close();
    await actions[what]?.(el, what);
  }
  document.addEventListener("click", (event) => {
    void action(event).catch((error) =>
      modal("errors.couldNotCompleteAction", `<p role="alert">${escape(error.message)}</p>`),
    );
  });
  document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.id === "projectSessionSearch")
      searchProjectSessions(event.target.value);
    if (event.target instanceof HTMLInputElement && event.target.id === "wbTaskSearch") {
      query = event.target.value;
      renderTaskResults();
    }
    if (event.target instanceof HTMLInputElement && event.target.id === "wbProjectSearch") {
      projectQuery = event.target.value;
      renderProjectResults();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target instanceof HTMLSelectElement && event.target.id === "projectSessionDirectory")
      filterProjectDirectory(event.target.value);
    if (event.target instanceof HTMLSelectElement && event.target.id === "wbTaskFilter") {
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
    else requireElement("#newTask")?.focus();
  });
  dialog.addEventListener("keydown", (e) => {
    const buttons = [...findElements("#wbCommandResults button", dialog)],
      index = buttons.findIndex((button) => button === document.activeElement);
    if (index >= 0 && ["ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowUp" && index === 0) requireElement("#wbCommandQuery", dialog).focus();
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
    if (closestElement('[data-wb="retry"]', event.target)) preparation.retry();
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
