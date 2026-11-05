import { messageHtml, setMessageHtml } from "../i18n.js";
import { errorMessage } from "./../../shared/errors.js";
import { request as fetch } from "./../http-client.js";

import { configureAttachmentUrls } from "../../shared/attachment-urls.js";
import { normalizeProjectPath } from "../../shared/project-visibility.js";
import { confirmAction } from "../confirmation-dialog.js";
import { createLifecycle } from "../lifecycle.js";
import { trackMobileViewport } from "../mobile-viewport.js";
import { takeStartupRead } from "../startup-reads.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { createLatestRequestGate } from "../ui-core.js";

// Coordinates initial reads, preparation retries, login invalidation and cache cleanup.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "sessions" | "workspacePreparation" | "state" | "$" | "escapeHtml" | "t" | "configurationReadiness", "transport" | "account" | "approvals" | "composer" | "sidebar" | "panels" | "usage" | "models" | "navigation" | "synchronization" | "notices" | "repositories" | "suggestions" | "projects" | "sidebarLayout" | "workspace" | "settings" | "status", "startup">} options */
export function assembleStartup({
  transportPort,
  viewUpdates,
  mutations,
  sessions,
  workspacePreparation,
  state,
  $,
  escapeHtml,
  t,
  accountPort,
  approvalsPort,
  composerPort,
  sidebarPort,
  panelsPort,
  usagePort,
  modelsPort,
  navigationPort,
  synchronizationPort,
  noticesPort,
  repositoriesPort,
  suggestionsPort,
  projectsPort,
  sidebarLayoutPort,
  workspacePort,
  settingsPort,
  statusPort,
  configurationReadiness,
}) {
  const initialLoadGate = createLatestRequestGate();
  const lifecycle = createLifecycle();
  function dispose() {
    lifecycle.dispose();
    sidebarPort.dispose();
    panelsPort.dispose();
    approvalsPort.approvalMenuController.dispose();
    noticesPort.dismissToast();
    repositoriesPort.persistentConversationCache.close();
  }
  function invalidateInitialLoad() {
    initialLoadGate.next();
  }
  async function clearSessionCaches() {
    repositoriesPort.sidebarCache.clear({ disableWrites: true });
    statusPort.sessionRuntime.clear();
    await repositoriesPort.conversations.clear();
  }
  async function loadInitial(refreshAccount = false) {
    workspacePreparation.start("sessions");
    const generation = initialLoadGate.next(),
      current = () => initialLoadGate.isCurrent(generation);
    accountPort.loadAccount(refreshAccount);
    void approvalsPort.refreshPendingApprovals();
    composerPort.loadComposerHistory();
    void sidebarPort.loadProjectVisibility().catch(() => {});
    if (usagePort.usagePageVisible()) usagePort.loadUsage();
    if (!state.threads.length)
      setMessageHtml(
        $("#threadList"),
        `<div class="list-state">${messageHtml("workbench.loadingSessions", undefined, t)}</div>`,
      );
    const report = (error) => {
      if (current() && !error?.silentTransportSwitch) noticesPort.addPersistentError(error.message);
    };
    const models = modelsPort.loadModels();
    const rememberedId = storage.get(STORAGE_KEYS.activeThread);
    const rememberedThread = navigationPort.startupThreadAllowed(rememberedId) ? rememberedId : null;
    const cachedConversation = navigationPort.restoreCachedStartup(rememberedThread, current);
    if (state.active?.history) synchronizationPort.scheduleActiveThreadSync(0);
    const threads = takeStartupRead("threads", () =>
      transportPort.rpc("thread/list", { limit: 50, sortKey: "recency_at", sortDirection: "desc" }),
    )
      .then(async (result) => {
        if (!current()) return;
        synchronizationPort.applyThreadSummaries(result.data || []);
        synchronizationPort.scheduleThreadListRefresh();
        await configurationReadiness.ready;
        if (!current()) return;
        await cachedConversation;
        if (!current()) return;
        if (!state.active && rememberedThread && rememberedThread === storage.get(STORAGE_KEYS.activeThread))
          await navigationPort.openThread(rememberedThread);
      })
      .catch((error) => {
        if (current() && !error?.silentTransportSwitch) workspacePreparation.fail("sessions");
        if (current()) {
          synchronizationPort.scheduleThreadListRefresh();
          if (!state.threads.length) {
            const cached = repositoriesPort.sidebarCache.read();
            if (cached?.threads.length) {
              sessions.replaceThreads(cached.threads);
              viewUpdates.request("sidebar");
            } else
              setMessageHtml(
                $("#threadList"),
                `<div class="list-state">${messageHtml("errors.couldNotLoadSessions", undefined, t)}</div>`,
              );
          }
        }
        report(error);
      });
    const profiles = configurationReadiness.ready.then(() => (current() ? modelsPort.loadPermissionProfiles() : null));
    await Promise.allSettled([models, threads, profiles]);
    if (!state.active) {
      composerPort.restoreComposerDraft();
      suggestionsPort.renderContextTray();
    }
  }
  async function boot() {
    workspacePreparation.start("connection");
    workspacePreparation.start("configuration");
    trackMobileViewport();
    const savedProject = storage.get(STORAGE_KEYS.project);
    sidebarLayoutPort.syncSidebarLayout();
    modelsPort.syncPermissionControl();
    if (repositoriesPort.cachedSidebar) viewUpdates.request("sidebar");
    configurationReadiness.start(
      (async () => {
        let configured = false;
        try {
          mutations.set(
            "config",
            await takeStartupRead("config", async () => {
              const response = await fetch("/api/config");
              if (!response.ok) throw new Error("Could not load workspace settings");
              return response.json();
            }),
          );
          configureAttachmentUrls(state.config.attachmentUrlPrefix);
          if (
            repositoriesPort.cachedSidebar?.home &&
            repositoriesPort.cachedSidebar.home !== state.config.home &&
            !synchronizationPort.threadListHasFreshData
          ) {
            sessions.replaceThreads([]);
            repositoriesPort.sidebarCache.saveThreads([], state.config.home);
          }
          configured = true;
        } catch {
          workspacePreparation.fail("configuration");
        }
        let initialProject = savedProject;
        if (savedProject && savedProject !== "~" && state.config.home) {
          const path = normalizeProjectPath(savedProject, state.config.home),
            roots = state.config.browseRoots || [state.config.home];
          if (
            !path ||
            !roots.some((root) => {
              const normalized = normalizeProjectPath(root);
              return (
                normalized && (path === normalized || path.startsWith(normalized === "/" ? "/" : normalized + "/"))
              );
            })
          ) {
            // A deployment can change mounted roots. Keep cached history, but do not
            // restore a workspace or active conversation from the previous runtime.
            initialProject = null;
            storage.remove(STORAGE_KEYS.project);
            navigationPort.rememberActiveThread(null);
            navigationPort.invalidateNavigation();
          }
        }
        if (state.config.projectless || initialProject === "~") workspacePort.setProjectless(false);
        else workspacePort.setWorkspace(initialProject || state.config.defaultCwd || ".", false);
        // Restore local drafts after validating the project, without waiting for
        // model/session RPCs. Keep any text already entered during startup.
        if (configured && !state.active && !$("#prompt").value) composerPort.restoreComposerDraft();
        if (state.threads.length) viewUpdates.request("sidebar");
        viewUpdates.request("composerPlaceholder");
        const initialSettingsPage = settingsPort.settingsRoutePage();
        if (initialSettingsPage) settingsPort.showSettings(initialSettingsPage, { updateRoute: false });
        if (configured) workspacePreparation.complete("configuration");
      })(),
    );
    void sidebarPort.loadProjectVisibility().catch(() => {});
    // Expiration is also checked on every cache read. Cleanup can wait until the
    // first sidebar/history paint instead of locking IndexedDB during startup.
    lifecycle.timeout(() => repositoriesPort.pruneConversationCaches(), 3000);
    lifecycle.interval(() => repositoriesPort.pruneConversationCaches(), 60_000);
    void navigationPort.restoreCachedStartup(storage.get(STORAGE_KEYS.activeThread), () => true);
    transportPort.connect();
    modelsPort.loadModels();
    await configurationReadiness.ready;
  }
  function bind() {
    workspacePreparation.registerRetry("configuration", async () => {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load workspace settings");
      mutations.set("config", await response.json());
      viewUpdates.request("workbench");
    });
    workspacePreparation.registerRetry("connection", () => {
      transportPort.connect();
      return state.connected;
    });
    workspacePreparation.registerRetry("sessions", async () => {
      const result = await transportPort.rpc("thread/list", {
        limit: 50,
        sortKey: "recency_at",
        sortDirection: "desc",
      });
      synchronizationPort.applyThreadSummaries(result.data || []);
      return result;
    });
    workspacePreparation.registerRetry("projects", () =>
      Promise.all([sidebarPort.loadProjectVisibilityRaw(), projectsPort.businessProjects.load()]),
    );
    workspacePreparation.registerRetry("models", () => modelsPort.loadModelsRaw());
    workspacePreparation.registerRetry("permissions", () => modelsPort.loadPermissionProfilesRaw());

    $("#accountLogout").onclick = async () => {
      viewUpdates.request("accountMenu", false);
      if (
        !(await confirmAction({
          title: "workbench.logOutOfModelAccount",
          message: "workbench.logOutOfTheModelAccountUsedByThisWorkspace",
          confirmText: "common.logOut",
          cancelText: "common.cancel",
          returnFocus: $("#accountButton"),
        }))
      )
        return;
      try {
        await transportPort.rpc("account/logout");
        await clearSessionCaches();
        viewUpdates.request("accountMenu", false);
        await accountPort.loadAccount(true);
      } catch (error) {
        noticesPort.addPersistentError(errorMessage(error));
      }
    };
    lifecycle.on(globalThis, "pagehide", (event) => {
      if (!event.persisted) dispose();
    });
    lifecycle.on(globalThis, "panda-force:logged-out", (event) => {
      initialLoadGate.next();
      synchronizationPort.stopSynchronization();
      const cleanup = clearSessionCaches().finally(dispose);
      event.detail?.waitUntil(cleanup);
    });
    lifecycle.on(globalThis, "panda-force:before-login", () => viewUpdates.request("composerDraft"));
  }

  return {
    dispose,
    invalidateInitialLoad,
    loadInitial,
    boot,
    bind,
  };
}
