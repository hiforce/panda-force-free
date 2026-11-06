import { createSidebarSessionBrowser } from "./sidebar-session-browser.js";
import { errorMessage } from "./../shared/errors.js";
import { createAnchoredMenu } from "./anchored-menu.js";
import { closestElement, findElement } from "./dom.js";
import { request as fetch } from "./http-client.js";
import {
  getBrowserI18n,
  localizeAttribute,
  localizeText,
  messageHtml,
  setMessageHtml,
  setOpaqueAttribute,
  setOpaqueText,
} from "./i18n.js";

import { normalizeProjectPath } from "../shared/project-visibility.js";
import { codexIcon } from "./codex-icons.js";
import { confirmAction } from "./confirmation-dialog.js";
import { threadLastActivityAt } from "./conversation-policy.js";
import { storage, STORAGE_KEYS } from "./storage.js";

/**
 * Session sidebar: project grouping with pin/expand/hide state, the project
 * and session context menus, thread deletion and the list renderer. App
 * behavior (opening threads, starting tasks, toasts) is injected.
 */
export function createThreadSidebar({
  sessions,
  $,
  t,
  state,
  projectCatalog = /** @type {ReturnType<typeof import("./project-catalog.js").createProjectCatalog> | null} */ (null),
  onProjectNewSession = (_projectId) => {},
  onSessionProject = /** @type {((id: string) => unknown) | null} */ (null),
  initialVisibility = /** @type {import("../shared/data-view.js").DataView<import("../shared/engine/types.js").ProjectVisibility> | null} */ (
    null
  ),
  onVisibility = (_visibility) => {},
  onRender = () => {},
  readVisibility,
  rpc,
  escapeHtml,
  shortPath,
  titleOf,
  openThread,
  startNewTask,
  setWorkspace,
  setProjectless,
  chooseProject,
  chooseProjectless,
  mobileSidebarEnabled,
  setSidebarOpen,
  updateThreadRowMeta,
  submitNativeSlashCommand,
  toast,
  toastProject,
  dismissToast,
  addPersistentError,
  refreshThreadList,
  cleanupDeletedThread,
  removeCachedConversation,
}) {
  if (!sessions) throw new Error("Session sidebar requires the session mutation capability");
  const sidebarPinnedProjects = (() => {
    try {
      const keys = JSON.parse(storage.get(STORAGE_KEYS.sidebarPinnedProjects) || "[]");
      return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : []);
    } catch {
      return new Set();
    }
  })();
  const sidebarPinnedThreads = (() => {
    try {
      const ids = JSON.parse(storage.get(STORAGE_KEYS.sidebarPinnedThreads) || "[]");
      return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  })();
  function saveSidebarPinnedThreads() {
    storage.set(STORAGE_KEYS.sidebarPinnedThreads, JSON.stringify([...sidebarPinnedThreads]));
  }
  function toggleSidebarThreadPinned(threadId) {
    if (sidebarPinnedThreads.has(threadId)) sidebarPinnedThreads.delete(threadId);
    else sidebarPinnedThreads.add(threadId);
    saveSidebarPinnedThreads();
    renderThreads();
  }
  const sidebarProjectCollator = { compare: (left, right) => getBrowserI18n().format.compare(left, right) };
  const sidebarProjectExpansion = (() => {
    try {
      return JSON.parse(storage.get(STORAGE_KEYS.sidebarProjectExpansion) || "{}");
    } catch {
      return {};
    }
  })();
  let sidebarProjectVisibility = initialVisibility || { revision: -1, hiddenProjects: {} };
  let visibilityConfirmed = false,
    visibilityRead = null,
    visibilityUpdatedAt = 0;
  let sidebarProjectMenu = null,
    sidebarProjectMenuTrigger = null,
    sidebarProjectMenuSelector = "";
  const SIDEBAR_SESSION_PAGE_SIZE = 5;
  const sidebarSessionLimits = new Map();
  const savedProject = storage.get(STORAGE_KEYS.project);
  function sidebarProjectKey(thread = {}) {
    if (projectCatalog) {
      const project = projectCatalog.projectForSession(thread.id);
      return project ? "project:" + project.id : "__tasks__";
    }
    return thread.projectless || !thread.cwd
      ? "__tasks__"
      : normalizeProjectPath(thread.cwd, state.config.home) || String(thread.cwd);
  }
  function sidebarProjectName(key) {
    if (key === "__pinned__") return t("sessions.pinned");
    if (key === "__tasks__") return projectCatalog ? t("sessions.unassignedSessions") : t("common.sessions");
    if (projectCatalog) return projectCatalog.get(key.slice(8))?.name || key;
    if (key === state.config.home) return "Home";
    return key.split("/").filter(Boolean).at(-1) || key;
  }
  function currentSidebarProjectKey() {
    if (projectCatalog)
      return state.active
        ? sidebarProjectKey(state.active)
        : state.newSessionProjectId
          ? "project:" + state.newSessionProjectId
          : "__tasks__";
    if (state.projectless || (!state.active && !state.workspaceContext && savedProject === "~")) return "__tasks__";
    return (
      normalizeProjectPath(
        state.active?.cwd || state.workspaceContext?.cwd || savedProject || $("#projectPath").textContent,
        state.config.home,
      ) || ""
    );
  }
  function saveSidebarProjectExpansion() {
    storage.set(STORAGE_KEYS.sidebarProjectExpansion, JSON.stringify(sidebarProjectExpansion));
  }
  function applyProjectVisibility(snapshot) {
    if (
      !Number.isSafeInteger(snapshot?.revision) ||
      snapshot.revision < 0 ||
      (visibilityConfirmed && snapshot.revision <= sidebarProjectVisibility.revision) ||
      !snapshot.hiddenProjects
    )
      return;
    for (const key of Object.keys(sidebarProjectVisibility.hiddenProjects)) {
      if (!Object.hasOwn(snapshot.hiddenProjects, key)) {
        sidebarProjectExpansion[key] = true;
        sidebarSessionLimits.delete(key);
        if (toastProject() === key) dismissToast();
      }
    }
    visibilityConfirmed = true;
    visibilityUpdatedAt = Date.now();
    sidebarProjectVisibility = { revision: snapshot.revision, hiddenProjects: snapshot.hiddenProjects };
    onVisibility(sidebarProjectVisibility);
    saveSidebarProjectExpansion();
    renderThreads();
  }
  function loadProjectVisibility() {
    if (visibilityRead) return visibilityRead;
    if (visibilityConfirmed && Date.now() - visibilityUpdatedAt < 5000) return Promise.resolve();
    visibilityRead = (async () => {
      try {
        const snapshot = readVisibility
          ? await readVisibility()
          : await fetch("/api/projects/visibility", { cache: "no-store" }).then((response) => {
              if (!response.ok) throw new Error(t("errors.couldNotLoadProjects"));
              return response.json();
            });
        applyProjectVisibility(snapshot);
      } catch (error) {
        if (sidebarProjectVisibility.revision < 0)
          localizeText($("#threadList"), "errors.couldNotLoadProjects", undefined, t);
        throw error;
      }
    })().finally(() => {
      visibilityRead = null;
    });
    return visibilityRead;
  }
  async function setProjectHidden(project, hidden, expectedHiddenAt) {
    const response = await fetch("/api/projects/visibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, hidden, expectedHiddenAt }),
    });
    if (!response.ok) throw new Error(t(hidden ? "errors.couldNotHideProject" : "errors.couldNotRestoreProject"));
    const snapshot = await response.json();
    applyProjectVisibility(snapshot);
    return snapshot;
  }
  async function hideSidebarProject(project) {
    closeSidebarProjectMenu();
    try {
      const snapshot = await setProjectHidden(project, true),
        hiddenAt = snapshot.hiddenProjects[project]?.hiddenAt;
      if (sidebarProjectVisibility.hiddenProjects[project]?.hiddenAt !== hiddenAt || !hiddenAt) return;
      $("#newTask").focus();
      toast(t("sessions.projectHiddenCreatingANewSessionWillShowItAgain"), 8000, {
        project,
        label: t("sessions.undo"),
        run: async () => {
          try {
            await setProjectHidden(project, false, hiddenAt);
            toast(
              t(
                sidebarProjectVisibility.hiddenProjects[project]
                  ? "common.projectIsStillHidden"
                  : "common.projectRestored",
              ),
            );
          } catch (error) {
            addPersistentError(errorMessage(error));
          }
        },
      });
    } catch (error) {
      addPersistentError(errorMessage(error));
    }
  }
  function startNewSessionInProject(project) {
    closeSidebarProjectMenu();
    if (projectCatalog) {
      onProjectNewSession(project.startsWith("project:") ? project.slice(8) : null);
      return;
    }
    if (project === "__tasks__" && chooseProjectless) {
      chooseProjectless();
      return;
    }
    if (project !== "__tasks__" && chooseProject) {
      void chooseProject(project).catch((error) => addPersistentError(error.message));
      return;
    }
    if (project === "__tasks__") {
      setProjectless();
      startNewTask();
      return;
    }
    setWorkspace(project);
    startNewTask();
  }
  const sidebarMenus = createAnchoredMenu({
    onClose: () => {
      sidebarProjectMenu?.remove();
      sidebarProjectMenu = null;
      sidebarProjectMenuTrigger = null;
      sidebarProjectMenuSelector = "";
    },
  });
  function closeSidebarProjectMenu(restoreFocus = false) {
    sidebarMenus.close(restoreFocus);
  }
  function showSidebarMenu(menu, trigger) {
    sidebarProjectMenu = menu;
    sidebarProjectMenuTrigger = trigger;
    const project = closestElement(".sidebar-project-group", trigger)?.dataset.project || "";
    const thread = closestElement(".thread-item", trigger)?.dataset.id;
    sidebarProjectMenuSelector = `[data-project="${CSS.escape(project)}"] ${thread ? `.thread-item[data-id="${CSS.escape(thread)}"] .thread-options` : ".sidebar-project-options"}`;
    sidebarMenus.toggle(trigger, menu);
  }
  function refreshSidebarMenu() {
    if (!sidebarProjectMenu) return;
    const trigger = findElement(sidebarProjectMenuSelector, $("#threadList"));
    sidebarProjectMenuTrigger = trigger;
    sidebarMenus.reanchor(trigger);
  }
  function openSidebarProjectMenu(project, trigger) {
    const wasOpen = sidebarProjectMenuTrigger === trigger;
    closeSidebarProjectMenu();
    if (wasOpen) return;
    const menu = document.createElement("div");
    menu.className = "sidebar-project-menu";
    menu.setAttribute("role", "menu");
    localizeAttribute(menu, "aria-label", "sessions.projectOptions", undefined, t);
    const create = document.createElement("button");
    create.type = "button";
    create.setAttribute("role", "menuitem");
    localizeText(create, "common.newSession", undefined, t);
    create.onclick = () => startNewSessionInProject(project);
    menu.append(create);
    const pinned = sidebarPinnedProjects.has(project),
      pin = document.createElement("button");
    pin.type = "button";
    pin.setAttribute("role", "menuitem");
    localizeText(pin, pinned ? "common.unpinProject" : "common.pinProject", undefined, t);
    pin.onclick = () => {
      if (pinned) sidebarPinnedProjects.delete(project);
      else sidebarPinnedProjects.add(project);
      storage.set(STORAGE_KEYS.sidebarPinnedProjects, JSON.stringify([...sidebarPinnedProjects]));
      closeSidebarProjectMenu();
      renderThreads();
    };
    menu.append(pin);
    const hide = document.createElement("button");
    hide.type = "button";
    hide.setAttribute("role", "menuitem");
    localizeText(hide, "sessions.hideProject", undefined, t);
    hide.onclick = () => hideSidebarProject(project);
    if (!projectCatalog) menu.append(hide);
    showSidebarMenu(menu, trigger);
  }
  function openSidebarThreadMenu(thread, trigger) {
    const wasOpen = sidebarProjectMenuTrigger === trigger;
    closeSidebarProjectMenu();
    if (wasOpen) return;
    const menu = document.createElement("div");
    menu.className = "sidebar-project-menu";
    menu.setAttribute("role", "menu");
    localizeAttribute(menu, "aria-label", "sessions.sessionOptions", undefined, t);
    const fork = document.createElement("button");
    fork.type = "button";
    fork.setAttribute("role", "menuitem");
    localizeText(fork, "sessions.forkSession", undefined, t);
    fork.onclick = () => {
      closeSidebarProjectMenu();
      void submitNativeSlashCommand(thread, "fork").catch((error) =>
        addPersistentError(error?.message || String(error)),
      );
    };
    menu.append(fork);
    const pinned = sidebarPinnedThreads.has(thread.id),
      pin = document.createElement("button");
    pin.type = "button";
    pin.setAttribute("role", "menuitem");
    localizeText(pin, pinned ? "common.unpinSession" : "common.pinSession", undefined, t);
    pin.onclick = () => {
      toggleSidebarThreadPinned(thread.id);
      closeSidebarProjectMenu();
    };
    menu.append(pin);
    if (onSessionProject) {
      const project = document.createElement("button");
      project.type = "button";
      project.setAttribute("role", "menuitem");
      localizeText(project, "common.changeProject", undefined, t);
      project.onclick = () => {
        closeSidebarProjectMenu();
        void onSessionProject(thread.id);
      };
      menu.append(project);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("role", "menuitem");
    localizeText(remove, "sessions.deleteSession", undefined, t);
    remove.onclick = () => {
      closeSidebarProjectMenu();
      deleteThread(thread, trigger);
    };
    menu.append(remove);
    showSidebarMenu(menu, trigger);
  }
  async function deleteThread(thread, returnFocus) {
    if (!thread?.id) return;
    const title = titleOf(thread);
    if (
      !(await confirmAction({
        title: "sessions.deleteSession2",
        message: "sessions.titleAndItsDescendantSessionsWillBePermanentlyDeletedThis",
        values: { title },
        confirmText: "sessions.deleteSession",
        cancelText: "common.cancel",
        returnFocus: () =>
          returnFocus?.isConnected
            ? returnFocus
            : findElement(
                ".thread-options",
                [...$("#threadList").querySelectorAll(".thread-item")].find((row) => row.dataset.id === thread.id),
              ),
      }))
    )
      return;
    try {
      await rpc("thread/delete", { threadId: thread.id });
      cleanupDeletedThread(thread.id);
      sidebarPinnedThreads.delete(thread.id);
      saveSidebarPinnedThreads();
      const wasActive = state.active?.id === thread.id;
      if (wasActive) startNewTask();
      await removeCachedConversation(thread.id);
      sessions.removeSummary(thread.id);
      await refreshThreadList();
      renderThreads();
      toast(t("sessions.threadDeleted"));
    } catch (error) {
      console.error("Could not delete thread", error);
      addPersistentError(errorMessage(error) || t("errors.couldNotDeleteThread"));
    }
  }
  function appendSessionRows(threads, visibleThreads) {
    for (const thread of visibleThreads) {
      const row = document.createElement("div");
      row.className = "thread-item" + (state.active?.id === thread.id ? " active" : "");
      row.dataset.id = thread.id;
      setOpaqueAttribute(row, "title", [titleOf(thread), shortPath(thread.cwd)].filter(Boolean).join(" — "));
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const name = document.createElement("span");
      name.className = "thread-name";
      setOpaqueText(name, titleOf(thread));
      const meta = document.createElement("span");
      meta.className = "thread-meta";
      const spinner = document.createElement("span");
      spinner.className = "thread-running";
      spinner.dataset.i18nUi = "";
      spinner.setAttribute("role", "img");
      const time = document.createElement("time");
      time.dataset.i18nUi = "";
      meta.append(time);
      row.append(spinner);
      updateThreadRowMeta(row, thread, meta);
      const options = document.createElement("button");
      options.type = "button";
      options.className = "thread-options";
      localizeAttribute(options, "title", "sessions.sessionOptions", undefined, t);
      localizeAttribute(options, "aria-label", "sessions.sessionOptionsForTitle", { title: titleOf(thread) }, t);
      options.setAttribute("aria-haspopup", "menu");
      options.setAttribute("aria-expanded", "false");
      setMessageHtml(options, codexIcon("ellipsis"));
      options.onclick = (event) => {
        event.stopPropagation();
        openSidebarThreadMenu(thread, options);
      };
      row.append(name, meta, options);
      const open = () => {
        if (mobileSidebarEnabled()) setSidebarOpen(false);
        openThread(thread.id);
      };
      row.onclick = (event) => {
        if (closestElement(".thread-options", event.target)) return;
        open();
      };
      row.onkeydown = (event) => {
        if (closestElement(".thread-options", event.target)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      };
      threads.append(row);
    }
  }
  const unassignedBrowser = projectCatalog
    ? createSidebarSessionBrowser({
        catalog: projectCatalog,
        t,
        appendRows: appendSessionRows,
        onError: (error) => addPersistentError(errorMessage(error)),
        onRender: refreshSidebarMenu,
      })
    : null;
  function renderThreads() {
    onRender();
    if (projectCatalog ? !projectCatalog.ready : sidebarProjectVisibility.revision < 0) {
      closeSidebarProjectMenu();
      setMessageHtml(
        $("#threadList"),
        `<div class="list-state">${messageHtml("common.loadingProjects2", undefined, t)}</div>`,
      );
      return;
    }
    const list = $("#threadList"),
      q = $("#threadSearch").value.trim().toLowerCase(),
      groups = new Map();
    setMessageHtml(list, "");
    for (const thread of projectCatalog ? projectCatalog.sessions() : state.threads) {
      const key = sidebarProjectKey(thread);
      if (
        !Object.hasOwn(sidebarProjectVisibility.hiddenProjects, key) &&
        (!q ||
          titleOf(thread).toLowerCase().includes(q) ||
          thread.cwd?.toLowerCase().includes(q) ||
          (projectCatalog && sidebarProjectName(key).toLowerCase().includes(q)))
      ) {
        const group = groups.get(key) || { key, threads: [] };
        group.threads.push(thread);
        groups.set(key, group);
      }
    }
    if (projectCatalog)
      for (const p of projectCatalog.projects()) {
        const key = "project:" + p.id;
        if (
          !Object.hasOwn(sidebarProjectVisibility.hiddenProjects, key) &&
          !groups.has(key) &&
          (!q || [p.name, p.code].join(" ").toLowerCase().includes(q))
        )
          groups.set(key, { key, threads: [] });
      }
    // Older unassigned sessions remain discoverable when every recently loaded session is linked.
    if (
      projectCatalog &&
      !groups.has("__tasks__") &&
      !Object.hasOwn(sidebarProjectVisibility.hiddenProjects, "__tasks__")
    )
      groups.set("__tasks__", { key: "__tasks__", threads: [] });
    const pinnedThreads = state.threads.filter(
      (thread) =>
        sidebarPinnedThreads.has(thread.id) &&
        (!q || titleOf(thread).toLowerCase().includes(q) || thread.cwd?.toLowerCase().includes(q)),
    );
    if (!q || pinnedThreads.length)
      groups.set("__pinned__", { key: "__pinned__", threads: pinnedThreads, pinnedGroup: true });
    const currentKey = currentSidebarProjectKey(),
      ordered = [...groups.values()].sort(
        (a, b) =>
          Number(b.key === "__pinned__") - Number(a.key === "__pinned__") ||
          Number(sidebarPinnedProjects.has(b.key)) - Number(sidebarPinnedProjects.has(a.key)) ||
          sidebarProjectCollator.compare(sidebarProjectName(a.key), sidebarProjectName(b.key)) ||
          a.key.localeCompare(b.key),
      );
    for (const group of ordered) {
      group.threads.sort((a, b) => threadLastActivityAt(b) - threadLastActivityAt(a));
      const limit =
          group.key === "__tasks__" && projectCatalog
            ? 10
            : sidebarSessionLimits.get(group.key) || SIDEBAR_SESSION_PAGE_SIZE,
        visibleThreads = q ? group.threads : group.threads.slice(0, limit),
        hasMore = !(projectCatalog && group.key === "__tasks__") && visibleThreads.length < group.threads.length;
      const containsActive = group.threads.some((thread) => thread.id === state.active?.id),
        expanded =
          group.pinnedGroup ||
          Boolean(q) ||
          (Object.hasOwn(sidebarProjectExpansion, group.key)
            ? sidebarProjectExpansion[group.key]
            : containsActive || group.key === currentKey),
        section = document.createElement("section");
      section.className = "sidebar-project-group";
      section.dataset.project = group.key;
      const pinned = sidebarPinnedProjects.has(group.key),
        pinnedGroup = group.key === "__pinned__";
      section.dataset.pinned = String(pinned);
      const header = document.createElement("div");
      header.className = "sidebar-project-header";
      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "sidebar-project-row";
      heading.setAttribute("aria-expanded", String(expanded));
      setOpaqueAttribute(
        heading,
        "title",
        pinnedGroup
          ? t("sessions.pinned")
          : projectCatalog
            ? sidebarProjectName(group.key)
            : group.key === "__tasks__"
              ? t("common.tasks")
              : shortPath(group.key),
      );
      setMessageHtml(
        heading,
        `${codexIcon(pinnedGroup ? "arrowUp" : group.key === "__tasks__" ? "messageSquare" : "folderOpen")}<span ${projectCatalog && group.key.startsWith("project:") ? "data-i18n-ignore" : ""}>${pinnedGroup ? messageHtml("sessions.pinned", undefined, t) : group.key === "__tasks__" ? messageHtml(projectCatalog ? "sessions.unassignedSessions" : "common.sessions", undefined, t) : escapeHtml(sidebarProjectName(group.key))}</span>${codexIcon("chevronRight", "sidebar-project-chevron")}`,
      );
      header.append(heading);
      if (group.key !== "__tasks__" && !pinnedGroup) {
        const options = document.createElement("button");
        options.type = "button";
        options.className = "sidebar-project-options";
        localizeAttribute(options, "title", "sessions.projectOptions", undefined, t);
        localizeAttribute(
          options,
          "aria-label",
          "sessions.projectOptionsForName",
          { name: sidebarProjectName(group.key) },
          t,
        );
        options.setAttribute("aria-haspopup", "menu");
        options.setAttribute("aria-expanded", "false");
        setMessageHtml(options, codexIcon("ellipsis"));
        options.onclick = () => openSidebarProjectMenu(group.key, options);
        header.append(options);
      }
      section.append(header);
      const threads = document.createElement("div");
      threads.className = "sidebar-project-threads" + (expanded ? " expanded" : "");
      threads.setAttribute("aria-hidden", String(!expanded));
      threads.inert = !expanded;
      threads.style.setProperty("--sidebar-thread-count", String(visibleThreads.length + (hasMore ? 1 : 0)));
      heading.onclick = () => {
        const next = heading.getAttribute("aria-expanded") !== "true";
        sidebarProjectExpansion[group.key] = next;
        saveSidebarProjectExpansion();
        heading.setAttribute("aria-expanded", String(next));
        threads.setAttribute("aria-hidden", String(!next));
        threads.inert = !next;
        threads.classList.toggle("expanded", next);
      };
      if (unassignedBrowser && group.key === "__tasks__") {
        threads.classList.add("sidebar-unassigned-browser");
        unassignedBrowser.render(threads, group.threads, q);
      } else appendSessionRows(threads, visibleThreads);
      if (pinnedGroup && !visibleThreads.length) {
        const empty = document.createElement("div");
        empty.className = "sidebar-pinned-empty";
        localizeText(empty, "sessions.noPinnedSessions", undefined, t);
        threads.append(empty);
      }
      if (hasMore) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "sidebar-sessions-more";
        localizeText(more, "sessions.showMoreSessions", undefined, t);
        more.onclick = () => {
          sidebarSessionLimits.set(group.key, limit + SIDEBAR_SESSION_PAGE_SIZE);
          sidebarProjectExpansion[group.key] = true;
          renderThreads();
          findElement(`[data-project="${CSS.escape(group.key)}"] .sidebar-sessions-more`, $("#threadList"))?.focus();
        };
        threads.append(more);
      }
      section.append(threads);
      list.append(section);
    }
    if (!list.children.length)
      setMessageHtml(
        list,
        `<div class="list-state">${messageHtml(q ? "common.noMatchingTasks" : "common.noVisibleProjects", undefined, t)}</div>`,
      );
    refreshSidebarMenu();
  }

  function getProjects() {
    if (projectCatalog)
      return projectCatalog.projects().map((p) => ({
        key: "project:" + p.id,
        hidden: Object.hasOwn(sidebarProjectVisibility.hiddenProjects, "project:" + p.id),
        pinned: sidebarPinnedProjects.has("project:" + p.id),
        threads: p.threads,
      }));
    const groups = new Map();
    for (const thread of state.threads) {
      if (thread.projectless || !thread.cwd) continue;
      const key = sidebarProjectKey(thread);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          hidden: Object.hasOwn(sidebarProjectVisibility.hiddenProjects, key),
          pinned: sidebarPinnedProjects.has(key),
          threads: [],
        };
        groups.set(key, group);
      }
      group.threads.push(thread);
    }
    for (const key of Object.keys(sidebarProjectVisibility.hiddenProjects))
      if (!groups.has(key)) groups.set(key, { key, hidden: true, pinned: sidebarPinnedProjects.has(key), threads: [] });
    return [...groups.values()];
  }
  function toggleProjectPinned(path) {
    if (sidebarPinnedProjects.has(path)) sidebarPinnedProjects.delete(path);
    else sidebarPinnedProjects.add(path);
    storage.set(STORAGE_KEYS.sidebarPinnedProjects, JSON.stringify([...sidebarPinnedProjects]));
    renderThreads();
  }
  return {
    dispose: () => sidebarMenus.dispose(),
    renderThreads,
    applyProjectVisibility,
    loadProjectVisibility,
    getProjects,
    setProjectHidden,
    toggleProjectPinned,
    isProjectPinned: (path) => sidebarPinnedProjects.has(path),
  };
}
