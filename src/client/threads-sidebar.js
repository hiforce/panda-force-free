import { createSessionState } from "./application/session-state.js";
import { normalizeProjectPath } from "../shared/project-visibility.js";
import { threadLastActivityAt } from "./ui-core.js";
import { codexIcon } from "./codex-icons.js";
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
  projectCatalog = null,
  onProjectNewSession = () => {},
  onSessionProject = null,
  initialVisibility = null,
  onVisibility = () => {},
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
  sessions ??= createSessionState(state);
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
  const sidebarProjectCollator = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });
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
    sidebarProjectMenuBounds = null;
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
    if (key === "__pinned__") return "Pinned";
    if (key === "__tasks__") return projectCatalog ? t("Unassigned sessions") : "Tasks";
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
              if (!response.ok) throw new Error(t("Could not load projects"));
              return response.json();
            });
        applyProjectVisibility(snapshot);
      } catch (error) {
        if (sidebarProjectVisibility.revision < 0) $("#threadList").textContent = t("Could not load projects");
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
    if (!response.ok) throw new Error(t(hidden ? "Could not hide project" : "Could not restore project"));
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
      toast(t("Project hidden. Creating a new session will show it again."), 8000, {
        project,
        label: t("Undo"),
        run: async () => {
          try {
            await setProjectHidden(project, false, hiddenAt);
            toast(t(sidebarProjectVisibility.hiddenProjects[project] ? "Project is still hidden" : "Project restored"));
          } catch (error) {
            addPersistentError(error.message);
          }
        },
      });
    } catch (error) {
      addPersistentError(error.message);
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
  function closeSidebarProjectMenu(restoreFocus = false) {
    sidebarProjectMenu?.remove();
    sidebarProjectMenu = null;
    if (sidebarProjectMenuTrigger) {
      sidebarProjectMenuTrigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && sidebarProjectMenuTrigger.isConnected) sidebarProjectMenuTrigger.focus();
    }
    sidebarProjectMenuTrigger = null;
    sidebarProjectMenuBounds = null;
  }
  function openSidebarProjectMenu(project, trigger) {
    const wasOpen = sidebarProjectMenuTrigger === trigger;
    closeSidebarProjectMenu();
    if (wasOpen) return;
    const menu = document.createElement("div");
    menu.className = "sidebar-project-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t("Project options"));
    const create = document.createElement("button");
    create.type = "button";
    create.setAttribute("role", "menuitem");
    create.textContent = t("New session");
    create.onclick = () => startNewSessionInProject(project);
    menu.append(create);
    const pinned = sidebarPinnedProjects.has(project),
      pin = document.createElement("button");
    pin.type = "button";
    pin.setAttribute("role", "menuitem");
    pin.textContent = t(pinned ? "Unpin project" : "Pin project");
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
    hide.textContent = t("Hide project");
    hide.onclick = () => hideSidebarProject(project);
    if (!projectCatalog) menu.append(hide);
    sidebarProjectMenu = menu;
    sidebarProjectMenuTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    document.body.append(menu);
    const bounds = trigger.getBoundingClientRect(),
      width = menu.offsetWidth,
      height = menu.offsetHeight;
    sidebarProjectMenuBounds = bounds;
    menu.style.left = `${Math.max(8, Math.min(bounds.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, bounds.bottom + 4 + height > innerHeight ? bounds.top - height - 4 : bounds.bottom + 4)}px`;
    const menuItems = projectCatalog ? [create, pin] : [create, pin, hide];
    menu.onkeydown = (event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index = menuItems.indexOf(document.activeElement),
          next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? menuItems.length - 1
                : event.key === "ArrowUp"
                  ? Math.max(0, index - 1)
                  : Math.min(menuItems.length - 1, index + 1);
        menuItems[next].focus();
      }
    };
    create.focus({ preventScroll: true });
  }
  function openSidebarThreadMenu(thread, trigger) {
    const wasOpen = sidebarProjectMenuTrigger === trigger;
    closeSidebarProjectMenu();
    if (wasOpen) return;
    const menu = document.createElement("div");
    menu.className = "sidebar-project-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t("Session options"));
    const fork = document.createElement("button");
    fork.type = "button";
    fork.setAttribute("role", "menuitem");
    fork.textContent = t("Fork session");
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
    pin.textContent = t(pinned ? "Unpin session" : "Pin session");
    pin.onclick = () => {
      toggleSidebarThreadPinned(thread.id);
      closeSidebarProjectMenu();
    };
    menu.append(pin);
    if (onSessionProject) {
      const project = document.createElement("button");
      project.type = "button";
      project.setAttribute("role", "menuitem");
      project.textContent = t("Change project");
      project.onclick = () => {
        closeSidebarProjectMenu();
        void onSessionProject(thread.id);
      };
      menu.append(project);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("role", "menuitem");
    remove.textContent = t("Delete thread");
    remove.onclick = () => {
      closeSidebarProjectMenu();
      deleteThread(thread);
    };
    menu.append(remove);
    sidebarProjectMenu = menu;
    sidebarProjectMenuTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    document.body.append(menu);
    const bounds = trigger.getBoundingClientRect(),
      width = menu.offsetWidth,
      height = menu.offsetHeight;
    sidebarProjectMenuBounds = bounds;
    menu.style.left = `${Math.max(8, Math.min(bounds.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, bounds.bottom + 4 + height > innerHeight ? bounds.top - height - 4 : bounds.bottom + 4)}px`;
    const menuItems = [...menu.querySelectorAll('[role="menuitem"]')];
    menu.onkeydown = (event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index = menuItems.indexOf(document.activeElement),
          next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? menuItems.length - 1
                : event.key === "ArrowUp"
                  ? Math.max(0, index - 1)
                  : Math.min(menuItems.length - 1, index + 1);
        menuItems[next].focus();
      }
    };
    fork.focus({ preventScroll: true });
  }
  document.addEventListener("click", (event) => {
    if (
      sidebarProjectMenu &&
      !event.composedPath().includes(sidebarProjectMenu) &&
      !event.composedPath().includes(sidebarProjectMenuTrigger)
    )
      closeSidebarProjectMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (!sidebarProjectMenu) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSidebarProjectMenu(true);
    } else if (event.key === "Tab") closeSidebarProjectMenu(true);
  });
  document.addEventListener(
    "scroll",
    () => {
      if (!sidebarProjectMenu || !sidebarProjectMenuTrigger || !sidebarProjectMenuBounds) return;
      const current = sidebarProjectMenuTrigger.getBoundingClientRect();
      if (["top", "left", "bottom", "right"].some((key) => Math.abs(current[key] - sidebarProjectMenuBounds[key]) > 1))
        closeSidebarProjectMenu(true);
    },
    true,
  );
  async function deleteThread(thread) {
    if (!thread?.id) return;
    const title = titleOf(thread);
    if (!confirm(t("Delete “{title}”? This permanently deletes the thread and its descendants.", { title }))) return;
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
      toast(t("Thread deleted"));
    } catch (error) {
      console.error("Could not delete thread", error);
      addPersistentError(error?.message || t("Could not delete thread"));
    }
  }
  function renderThreads() {
    onRender();
    closeSidebarProjectMenu();
    if (projectCatalog ? !projectCatalog.ready : sidebarProjectVisibility.revision < 0) {
      $("#threadList").innerHTML = `<div class="list-state">${escapeHtml(t("Loading projects…"))}</div>`;
      return;
    }
    const list = $("#threadList"),
      q = $("#threadSearch").value.trim().toLowerCase(),
      groups = new Map();
    list.innerHTML = "";
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
      const limit = sidebarSessionLimits.get(group.key) || SIDEBAR_SESSION_PAGE_SIZE,
        visibleThreads = q ? group.threads : group.threads.slice(0, limit),
        hasMore = visibleThreads.length < group.threads.length;
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
      heading.title = pinnedGroup
        ? t("Pinned")
        : projectCatalog
          ? sidebarProjectName(group.key)
          : group.key === "__tasks__"
            ? t("Tasks")
            : shortPath(group.key);
      heading.innerHTML = `${codexIcon(pinnedGroup ? "arrowUp" : group.key === "__tasks__" ? "messageSquare" : "folderOpen")}<span ${projectCatalog && group.key.startsWith("project:") ? "data-i18n-ignore" : ""}>${escapeHtml(sidebarProjectName(group.key))}</span>${codexIcon("chevronRight", "sidebar-project-chevron")}`;
      header.append(heading);
      if (group.key !== "__tasks__" && !pinnedGroup) {
        const options = document.createElement("button");
        options.type = "button";
        options.className = "sidebar-project-options";
        options.title = t("Project options");
        options.setAttribute("aria-label", t("Project options for “{name}”", { name: sidebarProjectName(group.key) }));
        options.setAttribute("aria-haspopup", "menu");
        options.setAttribute("aria-expanded", "false");
        options.innerHTML = codexIcon("ellipsis");
        options.onclick = () => openSidebarProjectMenu(group.key, options);
        header.append(options);
      }
      section.append(header);
      const threads = document.createElement("div");
      threads.className = "sidebar-project-threads" + (expanded ? " expanded" : "");
      threads.setAttribute("aria-hidden", String(!expanded));
      threads.style.setProperty("--sidebar-thread-count", String(visibleThreads.length + (hasMore ? 1 : 0)));
      heading.onclick = () => {
        const next = heading.getAttribute("aria-expanded") !== "true";
        sidebarProjectExpansion[group.key] = next;
        saveSidebarProjectExpansion();
        heading.setAttribute("aria-expanded", String(next));
        threads.setAttribute("aria-hidden", String(!next));
        threads.classList.toggle("expanded", next);
      };
      for (const thread of visibleThreads) {
        const row = document.createElement("div");
        row.className = "thread-item" + (state.active?.id === thread.id ? " active" : "");
        row.dataset.id = thread.id;
        row.title = [titleOf(thread), shortPath(thread.cwd)].filter(Boolean).join(" — ");
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        const name = document.createElement("span");
        name.className = "thread-name";
        name.textContent = titleOf(thread);
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
        options.title = t("Session options");
        options.setAttribute("aria-label", t("Session options for “{title}”", { title: titleOf(thread) }));
        options.setAttribute("aria-haspopup", "menu");
        options.setAttribute("aria-expanded", "false");
        options.innerHTML = codexIcon("ellipsis");
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
          if (event.target.closest(".thread-options")) return;
          open();
        };
        row.onkeydown = (event) => {
          if (event.target.closest(".thread-options")) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        };
        threads.append(row);
      }
      if (pinnedGroup && !visibleThreads.length) {
        const empty = document.createElement("div");
        empty.className = "sidebar-pinned-empty";
        empty.textContent = t("No pinned sessions");
        threads.append(empty);
      }
      if (hasMore) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "sidebar-sessions-more";
        more.textContent = t("Show more sessions");
        more.onclick = () => {
          sidebarSessionLimits.set(group.key, limit + SIDEBAR_SESSION_PAGE_SIZE);
          sidebarProjectExpansion[group.key] = true;
          renderThreads();
          $("#threadList")
            .querySelector(`[data-project="${CSS.escape(group.key)}"] .sidebar-sessions-more`)
            ?.focus();
        };
        threads.append(more);
      }
      section.append(threads);
      list.append(section);
    }
    if (!list.children.length)
      list.innerHTML = `<div class="list-state">${escapeHtml(t(q ? "No matching tasks" : "No visible projects"))}</div>`;
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
    renderThreads,
    applyProjectVisibility,
    loadProjectVisibility,
    getProjects,
    setProjectHidden,
    toggleProjectPinned,
    isProjectPinned: (path) => sidebarPinnedProjects.has(path),
  };
}
