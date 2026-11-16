import { captureRenderFocus, restoreRenderFocus } from "./render-focus.js";
import { systemGadgetCapabilities, gadgetApplicationNavigation } from "../gadget/system/bindings.js";
import { systemGadgetRegistry } from "../gadget/system/client.js";
import { systemComposerMount } from "../gadget/system/composer/host.js";
import { GadgetWorkspace } from "./gadget/workspace.js";
import { createLazySettingsPage } from "./settings-pages/lazy.js";
import { createLazyTemplateManager } from "./templates/lazy-settings.js";
import { createLazyContentWorkspace } from "./creative/lazy-workspace.js";
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
import { createDocumentWorkspace } from "./documents/controller.js";
import { createProjectDocumentWorkspace } from "./documents/authoring/controller.js";
import { createDocumentPublicationWorkspace } from "./documents/publication/controller.js";
import { createPackageManager } from "./plugins/controller.js";
import { createPublishingWorkspace } from "./publishing/controller.js";
import { createEditorialWorkspace } from "./editorial/controller.js";
import { createSiteBuildWorkspace } from "./builds/controller.js";
import { createDeliveryWorkspace } from "./delivery/controller.js";
import { createSocialWorkspace } from "./social/controller.js";
import { createWorkbenchViews } from "./workbench-views.js";

import { codexIcon } from "./codex-icons.js";
import { createProjectDialogs } from "./project-dialogs.js";
import { storage } from "./storage.js";
import { createWorkbenchFrame } from "./workbench-chrome/frame.js";
import { parseWorkbenchRoute, workbenchLinkPath } from "./workbench-route.js";
export { parseWorkbenchRoute } from "./workbench-route.js";

const INTRO_KEY = "panda-force-introduction-dismissed";

export function createWorkbench({
  state,
  t,
  i18n,
  preparation,
  identityKey,
  openThread,
  newTask,
  chooseFolder,
  chooseProject,
  setProjectless,
  showSettings,
  hideSettings = () => {},
  catalog,
  setProjectHidden,
  toggleProjectPinned,
  isProjectPinned,
  taskStatus,
  hasPendingApproval,
  closeSidebar,
  openFiles,
  onViewChange = () => {},
}) {
  createWorkbenchFrame(t);
  const shell = requireElement(".conversation-shell"),
    viewport = requireElement(".conversation-viewport"),
    dock = requireElement(".composer-dock"),
    picker = requireElement("#conversationProjectPicker");
  const view = document.createElement("section");
  view.id = "workbenchView";
  view.className = "workbench-view";
  view.tabIndex = 0;
  setMessageHtml(
    view,
    '<div id="workbenchHero"></div><div id="workbenchComposerSlot" hidden></div><div id="workbenchContent"></div>',
  );
  shell.prepend(view);
  const content = requireElement("#workbenchContent", view),
    hero = findElement("#workbenchHero", view),
    slot = requireElement("#workbenchComposerSlot", view);
  const delivery = createDeliveryWorkspace(t);
  const building = createSiteBuildWorkspace(t, delivery);
  const publishing = createPublishingWorkspace(t, createSocialWorkspace(t));
  const editorial = createEditorialWorkspace(t);
  const documentSources = createDocumentWorkspace({
    t,
    identityKey,
    publishing,
    building,
    delivery,
    packages: createPackageManager(t),
  });
  const documents = createProjectDocumentWorkspace({
    t,
    identityKey,
    sources: documentSources,
    publishing: createDocumentPublicationWorkspace(t, {
      building,
      channels: publishing,
      editorial,
      identityKey,
      destinations: {
        open: (space, scope) =>
          delivery.open(space, undefined, scope?.storage === "files" ? scope.projectId : undefined),
        close: delivery.close,
      },
    }),
  });
  const creative = createLazyContentWorkspace(
    "create",
    t,
    identityKey,
    () => catalog.projects(),
    (path) => navigate(path),
    undefined,
    (host, project, closed) => composerMount(host, project, closed),
  );
  const projectDocuments = createLazyContentWorkspace("directory", t, identityKey, () => catalog.projects(), navigate);
  const projectContent = createLazyContentWorkspace(
    "project",
    t,
    identityKey,
    () => catalog.projects(),
    (path) => navigate(path),
    undefined,
    (host, project, closed) => composerMount(host, project, closed),
  );
  const templateManager = createLazyTemplateManager(t, identityKey);
  const skills = createLazyContentWorkspace(
    "skills",
    t,
    identityKey,
    () => catalog.projects(),
    (path) => navigate(path),
    templateManager,
  );
  const publish = createLazyContentWorkspace(
    "publish",
    t,
    identityKey,
    () => catalog.projects(),
    (path) => navigate(path),
    templateManager,
  );
  const bots = createLazySettingsPage(t, "botWorkspace");
  const navigation = document.createElement("nav");
  navigation.className = "workbench-navigation";
  localizeAttribute(navigation, "aria-label", "workbench.workspaceNavigation", undefined, t);
  requireElement(".sidebar-top").append(navigation);
  const connection = document.createElement("button");
  connection.type = "button";
  connection.className = "workbench-connection";
  connection.id = "workbenchConnection";
  requireElement(".sidebar-footer").prepend(connection);
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
        newTask({
          projectId: requireElement("select", projectContext).value || null,
        }),
      );
    }
    projectContext.hidden = !["new", "task", "settings"].includes(route.page);
  }
  const labels = {
    workspace: "common.workspace",
    bots: "cli.botWorkspace",
    tasks: "common.sessions",
    projects: "common.projects",
    project: "common.projectDetails",
    deliverables: "common.deliverables",
    connections: "common.connections",
    documents: "documents.title",
    create: "creative.create",
    skills: "creative.skills",
    publish: "creative.publish",
    new: "common.newSession",
    task: "common.session",
    settings: "common.settings",
  };
  const iconNames = {
    create: "pencil",
    skills: "layout",
    publish: "send",
    workspace: "monitor",
    bots: "bot",
    tasks: "list",
    projects: "folderOpen",
    deliverables: "file",
    connections: "plug",
    settings: "settings",
  };
  const {
    button,
    allProjects,
    visibleThreads,
    status,
    heading,
    renderTasks,
    renderTaskResults,
    renderProjects,
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
    identityKey,
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
    },
  });
  const gadgetRegistry = systemGadgetRegistry();
  const gadgetCapabilities = systemGadgetCapabilities({
    identity: identityKey,
    navigate,
    creationProject: () => state.newSessionProjectId || "personal",
    taskDraft: (project) =>
      state.active || (state.newSessionProjectId || "personal") !== project ? "" : requireElement("#prompt").value,
    startTask: (prompt, project) => {
      const selected = project === "personal" ? null : project;
      newTask({ projectId: selected, keepRoute: true });
      const input = requireElement("#prompt");
      input.value = prompt;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      navigate("/new" + (selected ? "?project=" + encodeURIComponent(selected) : ""));
      requireElement("#composer").requestSubmit();
    },
    ready: () => catalog.ready,
    sessions: visibleThreads,
    projects: allProjects,
    projectForSession: (id) => catalog.projectForSession(id),
    status,
  });
  const composerMount = systemComposerMount(gadgetRegistry, gadgetCapabilities, t, () => i18n.locale);
  const gadgetHome = new GadgetWorkspace(
    t,
    () => i18n.locale,
    gadgetRegistry,
    gadgetCapabilities,
    gadgetApplicationNavigation(navigate),
  );

  function render() {
    const focus = captureRenderFocus(view);
    const conversation =
      !(unavailableId && unavailableId === route.id) &&
      (route.page === "new" || route.page === "task" || route.page === "settings");
    hideInactiveWorkspaces();
    document.body.dataset.workbenchPage = route.page;
    document.title = `PandaForce · ${t(labels[route.page] || "common.workspace")}`;
    syncConversationSurfaces(conversation);
    renderPage(conversation);
    renderNavigation();
    if (!conversation)
      localizeText(requireElement("#threadTitle"), labels[route.page] || "common.workspace", undefined, t);
    if (!conversation) setOpaqueText(requireElement("#threadPath"), "");
    renderProjectContext();
    renderPreparation();
    onViewChange();
    restoreRenderFocus(view, focus);
  }
  function hideInactiveWorkspaces() {
    if (route.page !== "workspace") gadgetHome.hide();
    if (route.page !== "documents") documents.hide();
    if (route.page !== "create") creative.hide();
    if (
      route.page !== "project" ||
      ["sessions", "documents"].includes(new URL(location.href).searchParams.get("tab") || "")
    )
      projectContent.hide();
    if (route.page !== "project" || new URL(location.href).searchParams.get("tab") !== "documents")
      projectDocuments.hide();
    if (route.page !== "skills") skills.hide();
    if (route.page !== "publish") publish.hide();
    if (route.page !== "bots") bots.hide();
  }
  function syncConversationSurfaces(conversation) {
    view.hidden = conversation;
    viewport.hidden = !conversation;
    dock.hidden = !conversation;
    picker.hidden = Boolean(state.active) || !conversation;
    if (conversation) {
      if (picker.parentNode !== shell) shell.insertBefore(picker, viewport);
      if (projectContext.parentNode !== shell) shell.insertBefore(projectContext, picker);
      if (dock.parentNode !== shell) shell.append(dock);
    } else {
      // Native projections may update their own visibility while this entry uses the registered composer.
      for (const item of [projectContext, picker, dock]) if (item.parentNode !== slot) slot.append(item);
    }
  }
  function renderPage(conversation) {
    if (route.page === "workspace") {
      setMessageHtml(hero, "");
      gadgetHome.show(content);
    } else {
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
        else if (route.page === "project") {
          if (new URL(location.href).searchParams.get("tab") === "sessions") {
            renderProject();
          } else if (new URL(location.href).searchParams.get("tab") === "documents")
            projectDocuments.show(content, route.id);
          else projectContent.show(content, route.id);
        } else if (route.page === "documents")
          documents.show(
            content,
            route.projectId,
            route.documentId,
            new URL(location.href).searchParams.get("knowledge") || "",
          );
        else if (route.page === "create") creative.show(content);
        else if (route.page === "skills")
          skills.show(content, route.id || "all", new URL(location.href).searchParams.get("engine") || "");
        else if (route.page === "publish") publish.show(content, route.id, route.projectId);
        else if (route.page === "bots") bots.show(content);
        else if (route.page === "connections") renderConnections();
        else renderDeliverables();
      }
    }
  }
  function renderNavigation() {
    const nav = [
      ["workspace", "common.workspace"],
      ["bots", "cli.botWorkspace"],
      ["tasks", "common.sessions"],
      ["create", "creative.create"],
      ["projects", "common.projects"],
      ["skills", "creative.skills"],
      ["publish", "creative.publish"],
    ].filter(
      ([page]) => globalThis.__pandaForceIdentity?.role !== "member" || ["create", "projects", "skills"].includes(page),
    );
    const activePage =
      ["project", "documents"].includes(route.page) || (route.page === "publish" && route.projectId)
        ? "projects"
        : route.page === "task"
          ? "tasks"
          : route.page;
    setMessageHtml(
      navigation,
      nav
        .map(
          ([key, label]) =>
            `<button type="button" data-wb="route" data-route="${key}" class="${activePage === key ? "active" : ""}" ${activePage === key ? 'aria-current="page"' : ""}><span class="icon-slot">${codexIcon(iconNames[key])}</span><span>${messageHtml(label, undefined, t)}</span></button>`,
        )
        .join(""),
    );
    setMessageHtml(
      bottom,
      nav
        .filter(([key]) => ["create", "tasks", "projects", "skills", "publish"].includes(key))
        .sort(
          ([a], [b]) =>
            ["create", "tasks", "projects", "skills", "publish"].indexOf(a) -
            ["create", "tasks", "projects", "skills", "publish"].indexOf(b),
        )
        .map(
          ([key, label]) =>
            `<button type="button" data-wb="route" data-route="${key}" class="${activePage === key ? "active" : ""}"><span class="icon-slot" aria-hidden="true">${codexIcon(iconNames[key])}</span>${messageHtml(label, undefined, t)}</button>`,
        )
        .join(""),
    );
    connection.hidden = globalThis.__pandaForceIdentity?.role === "member";
    setMessageHtml(
      connection,
      `<span class="status-dot ${state.connected ? "connected" : "error"}"></span><span>${messageHtml(state.connected ? "common.codexConnected" : "auth.connectionUnavailable", undefined, t)}</span>`,
    );
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
    if (location.pathname + location.search + location.hash !== path)
      history[replace ? "replaceState" : "pushState"]({ pandaForce: true }, "", path);
  }
  function navigate(path, { replace = false } = {}) {
    path = { "/settings/templates": "/skills/writing", "/settings/publishing-styles": "/publish" }[path] || path;
    const url = new URL(path.startsWith("/") ? path : "/" + path, location.origin);
    if (url.origin !== location.origin) return;
    const next = parseWorkbenchRoute(url);
    routing = true;
    unavailableId = "";
    if (next.page === "workspace" && state.active) newTask();
    if (next.page !== "settings") {
      hideSettings();
      updateUrl(url.pathname + url.search + url.hash, replace);
    }
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
        // A superseded startup read may return false after another read opened an empty session.
        // Its composer remains usable; a loaded session does not require an existing turn.
        if (!ok && route.page === "task" && route.id === id && state.active?.id !== id) {
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
    route = { page: "task", id, cwd: "", projectId: "", documentId: "" };
    updateUrl("/task/" + encodeURIComponent(id));
    render();
  }
  function taskStarted() {
    if (routing) return;
    route = { page: "new", id: "", cwd: "", projectId: "", documentId: "" };
    updateUrl("/new" + (state.newSessionProjectId ? "?project=" + encodeURIComponent(state.newSessionProjectId) : ""));
    render();
  }
  function refresh() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      // A slower cached/history read may recover after an earlier startup read was superseded.
      if (unavailableId === state.active?.id) {
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
        route.page === "projects"
          ? catalog.projects().map((project) => [project.id, isProjectPinned("project:" + project.id)])
          : null,
        state.newSessionProjectId,
        state.workspaceContext?.cwd,
      ]);
      if (next !== signature) {
        signature = next;
        render();
      }
    });
  }
  function modal(title, body, kind = "default") {
    returnFocus = document.activeElement;
    dialog.classList.toggle("workbench-search-dialog", kind === "search");
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
    if (event.defaultPrevented) return;
    const el = event.target instanceof Element ? closestElement("[data-wb]", event.target) : null;
    const anchor = event.target instanceof Element ? closestElement("a[href]", event.target) : null;
    if (anchor instanceof HTMLAnchorElement && (!el || el.dataset.wb === "route")) {
      const path = workbenchLinkPath(anchor, event);
      if (!path) return;
      event.preventDefault();
      if (dialog.open) dialog.close();
      navigate(path);
      return;
    }
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
    gadgetHome.refresh();
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
  if (location.pathname !== "/" && route.page === "new") {
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
