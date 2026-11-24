import { runtimeModelCatalog as loadRuntimeCatalog } from "./model-catalog.js";
import type { HarnessBrowserBoundary } from "../contracts/harness.js";
import { runtimeModelCatalog as projectRuntimeCatalog } from "../../shared/engine/runtime-selection.js";
import { escapeHtml } from "../../shared/html.js";
import { isRecord } from "../../shared/records.js";
import { harnessId, harnessPresentation, harnessSummary } from "../../shared/harness/presentation.js";
import {
  HARNESS_PERMISSION_MODES,
  type HarnessCatalog,
  type HarnessConversation,
  type HarnessRuntimeView,
  type HarnessPermissionMode,
} from "../../shared/harness/contracts.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { StateReader, StateStore } from "../contracts/ownership.js";
import type { ComposerPort, NavigationPort, ModelsPort, NoticesPort } from "../contracts/features.js";
import type { BusinessProjects } from "../contracts/features.js";
import { harnessApi, conversationsPath, type HarnessSnapshot } from "./api.js";
import { setMessageHtml } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { bindMenuDismiss, mountSessionMenu, restoreSessionMenu } from "../session-controls/menu.js";
import { creationSessionRoute } from "../creation/session-route.js";
import { parseWorkbenchRoute } from "../workbench-route.js";
import { harnessPermissionCard } from "./permission-card.js";
/** Composer selection owns no conversation state; navigation, model controls and drafts keep their existing ports. */
export function createHarnessController(options: {
  t: Translate;
  state: StateReader<"harness">;
  subscribe: StateStore["subscribe"];
  composer: ComposerPort;
  navigation: NavigationPort;
  models: ModelsPort;
  notices: NoticesPort;
  projects: Pick<BusinessProjects, "projectForSession" | "pendingAssignments" | "finishAssignment">;
  emit(message: unknown): void;
}) {
  const { t, state } = options,
    api = harnessApi(t),
    runtimeCatalog = loadRuntimeCatalog(t, true),
    trigger = document.querySelector<HTMLButtonElement>("#harnessButton")!;
  const panel = document.createElement("div");
  panel.className = "harness-menu composer-panel";
  panel.hidden = true;
  panel.role = "dialog";
  panel.id = "harnessMenu";
  document.body.append(panel);
  const snapshots = new Map<string, HarnessSnapshot>(),
    requests = new Map<string, string>(),
    permissionSubmissions = new Set<string>();
  const discoveries = new Map<string, Promise<HarnessRuntimeView>>();
  const discoveredUntil = new Map<string, number>();
  let catalog: HarnessCatalog | null = null,
    selected = "",
    selectedExplicitly = false,
    previousActive = "",
    busy = false,
    switchingId = "",
    scope = "",
    timer: ReturnType<typeof setTimeout> | null = null,
    modelsContext = "",
    epoch = 0,
    ready = false,
    disposed = false;
  const presentation = (value: HarnessSnapshot) =>
    harnessPresentation(value, (code) => t(code as Extract<MessageId, `harness.error${string}`>));
  function materialId(value: string) {
    const url = new URL(value, location.origin);
    if (url.origin === location.origin && url.pathname === "/api/chat-materials/original") {
      const id = url.searchParams.get("id");
      if (id && /^[a-f0-9-]{36}$/.test(id)) return `material:${id}`;
      throw Error(t("harness.errorInvalidInput"));
    }
    return value;
  }
  const current = () => harnessId(state.active?.id);
  const context = () => state.active?.id || `new:${state.newSessionProjectId || "personal"}`;
  const newPermissionModes = new Map<string, HarnessPermissionMode>();
  const permissionSaves = new Set<string>();
  const permissionKey = () => `${context()}:${runtime()?.id ?? "pending"}`;
  const permissionMessages = {
    ask: ["harness.permissionAsk", "harness.permissionAskDescription"],
    "accept-edits": ["harness.permissionClaudeEdit", "harness.permissionClaudeEditDescription"],
    plan: ["harness.permissionClaudePlan", "harness.permissionClaudePlanDescription"],
    "always-approve": ["harness.permissionAlways", "harness.permissionAlwaysDescription"],
    "deny-unapproved": ["harness.permissionClaudeDeny", "harness.permissionClaudeDenyDescription"],
    "full-access": ["common.fullAccess", "common.unrestrictedAccessToTheInternetAndAnyFileOnYour"],
  } as const;
  const runtime = () =>
    catalog?.runtimes.find(
      (runtime) =>
        runtime.id ===
        (current()
          ? snapshots.get(current()!)?.conversation.runtimeId
          : state.active
            ? "codex"
            : selected || catalog?.defaultRuntimeId),
    );
  function close() {
    scope = "";
    panel.hidden = true;
    restoreSessionMenu(panel);
    trigger.setAttribute("aria-expanded", "false");
  }
  function syncRoute() {
    const { page } = parseWorkbenchRoute();
    trigger.hidden = !catalog?.runtimes.length || (page !== "new" && page !== "task");
    if (scope && (trigger.hidden || scope !== context())) close();
  }
  function sync() {
    const value = runtime(),
      switching = catalog?.runtimes.find((entry) => entry.id === switchingId),
      label = busy && switching ? `${switching.name} · ${t("harness.switching")}` : (value?.name ?? "Harness");
    if (value) {
      const managed = !!current() || (!state.active && selected !== "codex"),
        next = managed ? `harness:${value.id}` : "codex",
        previous = modelsContext;
      if (next !== previous) {
        modelsContext = next;
        if (managed || previous) void options.models.loadModels({ attempts: 1 }).catch(() => {});
      }
    }
    syncRoute();
    trigger.disabled = busy || state.active?.turns?.some((turn) => turn.status === "inProgress") === true;
    trigger.setAttribute("aria-busy", String(busy));
    trigger.title = t("harness.select");
    trigger.setAttribute("aria-label", `${t("harness.select")} · ${label}`);
    setMessageHtml(
      trigger,
      `${codexIcon("plug")}<span class="harness-label">${escapeHtml(label)}</span>${codexIcon("chevronDown")}`,
    );
  }
  async function loadCatalog() {
    catalog = await api<HarnessCatalog>("/api/harness-runtimes");
    if (!selectedExplicitly || !catalog.runtimes.some((value) => value.id === selected && value.enabled))
      selected = catalog.defaultRuntimeId;
    sync();
  }
  async function ensureRuntime(id: string) {
    const target = catalog?.runtimes.find((entry) => entry.id === id && entry.enabled);
    if (!target) throw Error(t("harness.errorNotFound"));
    const key = JSON.stringify([id, target.revision]),
      previous = discoveries.get(key);
    if (target.status === "ready" && target.models.length && (discoveredUntil.get(key) ?? 0) > Date.now())
      return target;
    if (previous) return previous;
    const work = runtimeCatalog.discover(id).then((discovered) => {
      if (disposed) return discovered;
      const current = catalog?.runtimes.find((entry) => entry.id === id && entry.enabled);
      if (!current || current.revision !== target.revision || discovered.revision !== target.revision)
        throw Error(t("harness.errorConflict"));
      catalog!.runtimes = catalog!.runtimes.map((entry) => (entry.id === id ? discovered : entry));
      discoveredUntil.set(key, Date.now() + 300000);
      if (discoveredUntil.size > 64) discoveredUntil.delete(discoveredUntil.keys().next().value!);
      if (!busy && !panel.hidden) {
        const status = panel.querySelector(`[data-harness-select="${CSS.escape(id)}"] small`);
        if (status)
          status.textContent =
            t(`harness.${discovered.status}`) + (discovered.isDefault ? ` · ${t("harness.default")}` : "");
      }
      return discovered;
    });
    discoveries.set(key, work);
    try {
      return await work;
    } finally {
      discoveries.delete(key);
    }
  }
  function warmRuntime(id: string) {
    if (busy || discoveries.size || id === runtime()?.id) return;
    // Focus/hover expresses selection intent; discovery sends no model prompt.
    void ensureRuntime(id).catch(() => {});
  }
  function renderMenu() {
    if (!catalog) return;
    const selectedId = runtime()?.id;
    setMessageHtml(
      panel,
      `<header class="composer-panel-heading"><h2>${escapeHtml(t("harness.select"))}</h2><button class="composer-panel-action" type="button" data-harness-close aria-label="${escapeHtml(t("common.close"))}">${codexIcon("x")}</button></header><div class="harness-options">${catalog.runtimes
        .filter((runtime) => runtime.enabled)
        .map(
          (runtime) =>
            `<button type="button" class="composer-settings-row" data-harness-select="${escapeHtml(runtime.id)}" ${busy ? "disabled" : ""}><span><strong>${escapeHtml(runtime.name)}</strong><small${busy && switchingId === runtime.id ? ' role="status"' : ""}>${escapeHtml(t(busy && switchingId === runtime.id ? "harness.switching" : `harness.${runtime.status}`))}${runtime.isDefault ? ` · ${escapeHtml(t("harness.default"))}` : ""}</small></span>${runtime.id === selectedId ? codexIcon("check") : ""}</button>`,
        )
        .join("")}</div><p class="harness-hint">${escapeHtml(t("harness.handoffHint"))}</p>`,
    );
    panel.querySelector<HTMLButtonElement>("[data-harness-close]")!.onclick = close;
    for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-harness-select]")) {
      button.onpointerenter = button.onfocus = () => warmRuntime(button.dataset.harnessSelect!);
      button.onclick = () =>
        void choose(button.dataset.harnessSelect!).catch((error) => options.notices.addPersistentError(error));
    }
  }
  async function choose(id: string) {
    if (id === runtime()?.id) {
      close();
      return context();
    }
    if (busy || state.active?.turns?.some((turn) => turn.status === "inProgress")) throw Error(t("harness.errorBusy"));
    busy = true;
    switchingId = id;
    const captured = context();
    let adopted: string | null = null;
    scope = captured;
    sync();
    renderMenu();
    options.composer.saveComposerDraft();
    try {
      await ensureRuntime(id);
      if (captured !== context()) throw Error(t("sessionview.sessionChanged"));
      const conversationId = current();
      if (conversationId) {
        const before = await snapshot(conversationId);
        const after = await api<HarnessSnapshot>(`${conversationsPath}/${conversationId}`, "PATCH", {
          runtimeId: id,
          revision: before.conversation.revision,
        });
        snapshots.set(conversationId, after);
      } else if (state.active?.id) {
        const result = await api<HarnessSnapshot>("/api/personal/harness/import", "POST", {
          threadId: state.active.id,
          runtimeId: id,
        });
        snapshots.set(result.conversation.id, result);
        if (captured === context()) {
          adopted = `harness:${result.conversation.id}`;
          const project = options.projects.projectForSession(state.active.id);
          if (project) options.projects.pendingAssignments.set(adopted, project.id);
          options.composer.saveComposerDraft(adopted);
          await options.navigation.openThread(`harness:${result.conversation.id}`, presentation(result));
          await options.projects.finishAssignment(presentation(result));
        }
      } else {
        selected = id;
        selectedExplicitly = true;
      }
      if (captured === context() || adopted === context()) {
        sync();
        close();
        await options.models.loadModels({ attempts: 1 });
        options.notices.toast(t("harness.switched"));
      }
      if (captured !== context() && adopted !== context()) throw Error(t("sessionview.sessionChanged"));
      close();
      return context();
    } finally {
      busy = false;
      switchingId = "";
      sync();
      if (!panel.hidden) renderMenu();
    }
  }
  async function snapshot(id: string, cursor?: string) {
    const result = await api<HarnessSnapshot>(
      `${conversationsPath}/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (!cursor) snapshots.set(id, result);
    return result;
  }
  async function modelCatalog(value: HarnessRuntimeView) {
    const discovered = await ensureRuntime(value.id);
    return projectRuntimeCatalog(discovered);
  }
  const boundary: HarnessBrowserBoundary = {
    syncRoute,
    managed: () => !!current() || (!state.active && !!selected && selected !== "codex"),
    context: () =>
      current() || (!state.active && !!selected && selected !== "codex")
        ? `harness:${runtime()?.id || `pending:${current()}`}`
        : "codex",
    controls: (view) => {
      if (!current() && (state.active || !selected || selected === "codex"))
        return { ...view, sessionId: context(), runtimeId: "codex" };
      const id = current(),
        snapshot = id ? snapshots.get(id) : null,
        permission = snapshot?.conversation.permissionMode ?? newPermissionModes.get(permissionKey()) ?? "ask",
        selectedRuntime = runtime(),
        availableModes = selectedRuntime?.capabilities?.permissionModes ?? [],
        claude = selectedRuntime?.kind === "claude-code",
        modes = claude ? HARNESS_PERMISSION_MODES : availableModes,
        allowFullAccess = view.permissions.some((item) => item.id === "full-access" && item.allowed),
        active = !!snapshot?.conversation.activeRunId;
      return {
        ...view,
        sessionId: context(),
        runtimeId: runtime()?.id,
        permission,
        permissionOwner: "harness",
        permissionHint: "harness.permissionUnavailable",
        settingsHint: "harness.permissionNextTurn",
        permissions: modes.map((mode) => {
          const messages =
            mode === "always-approve" && claude
              ? (["harness.permissionClaudeAuto", "harness.permissionClaudeAutoDescription"] as const)
              : permissionMessages[mode];
          const offered = availableModes.includes(mode),
            fullAccessBlocked = mode === "full-access" && !allowFullAccess,
            reason = !offered
              ? "harness.permissionClaudeNotOffered"
              : fullAccessBlocked
                ? "harness.permissionClaudeFullRestricted"
                : null;
          return {
            id: mode,
            label: t(messages[0]),
            description: t(messages[1]),
            allowed: offered && !active && !permissionSaves.has(permissionKey()) && !fullAccessBlocked,
            ...(claude && reason ? { unavailableReason: t(reason) } : {}),
          };
        }),
      };
    },
    async applyRuntime(sessionId, runtimeId) {
      if (sessionId !== context()) throw Error(t("sessionview.sessionChanged"));
      return choose(runtimeId);
    },
    async applyPermission(sessionId, mode) {
      if (!boundary.managed()) return false;
      const id = current(),
        captured = context(),
        key = permissionKey();
      if (sessionId !== (state.active?.id ?? captured)) throw Error(t("sessionview.sessionChanged"));
      if (!runtime()?.capabilities?.permissionModes?.includes(mode as HarnessPermissionMode))
        throw Error(t("harness.errorCapabilityUnavailable"));
      if (permissionSaves.has(key)) return true;
      permissionSaves.add(key);
      try {
        if (id) {
          const value = await snapshot(id);
          const result = await api<HarnessSnapshot>(`${conversationsPath}/${id}`, "PATCH", {
            permissionMode: mode,
            revision: value.conversation.revision,
          });
          snapshots.set(id, result);
        } else newPermissionModes.set(key, mode as HarnessPermissionMode);
      } finally {
        permissionSaves.delete(key);
        options.models.syncModelLabel();
      }
      return true;
    },
    available: () => !!current() || (!!runtime() && runtime()!.id !== "codex" && runtime()!.status === "ready"),
    async rpc(method, params, next) {
      const id = harnessId(params.threadId),
        value = runtime();
      if (method === "model/list" && value) return modelCatalog(value);
      if (method === "thread/list") {
        if (params.cursor) return next();
        const [native, managed] = await Promise.allSettled([
          next(),
          api<{ conversations: HarnessConversation[] }>(conversationsPath),
        ]);
        if (managed.status === "rejected") {
          if (native.status === "fulfilled") return native.value;
          throw managed.reason;
        }
        const result =
          native.status === "fulfilled" && isRecord(native.value) ? native.value : { data: [], nextCursor: null };
        return {
          ...result,
          data: [
            ...managed.value.conversations.map(harnessSummary),
            ...(Array.isArray(result.data) ? result.data : []),
          ].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
        };
      }
      if (method === "thread/start" && !creationSessionRoute() && selected && selected !== "codex") {
        const result = await api<HarnessSnapshot>(conversationsPath, "POST", {
          runtimeId: selected,
          cwd: params.cwd,
          projectId: params.pandaProjectId,
          permissionMode: newPermissionModes.get(permissionKey()) ?? "ask",
        });
        snapshots.set(result.conversation.id, result);
        newPermissionModes.delete(permissionKey());
        return { thread: harnessPresentation(result), pandaHarness: true, pandaProjectId: params.pandaProjectId };
      }
      if (!id) return next();
      if (method === "thread/delete") {
        await api(`${conversationsPath}/${id}`, "DELETE");
        snapshots.delete(id);
        options.notices.removePersistentError("harness-read");
        if (current() === id) document.querySelector("#harnessInteractions")?.replaceChildren();
        return {};
      }
      if (["thread/read", "thread/resume", "host/thread/history", "host/thread/live"].includes(method)) {
        const result = await snapshot(id, typeof params.cursor === "string" ? params.cursor : undefined),
          thread = presentation(result);
        sync();
        if (method === "host/thread/live")
          return {
            thread,
            active: !!result.conversation.activeRunId,
            turn: thread.turns.at(-1) ?? null,
            tokenUsage: thread.tokenUsage,
          };
        if (method === "host/thread/history")
          return {
            thread,
            history: {
              ...thread.history,
              mode: params.cursor || params.revision ? "delta" : "snapshot",
              reset: !params.cursor && !params.revision,
              preserveOlderPages: !params.cursor && !!params.revision,
              turns: thread.turns,
              oldestItemId: thread.turns[0]?.items[0]?.id ?? null,
            },
          };
        return { thread };
      }
      if (method === "turn/start") {
        if (!Array.isArray(params.input)) throw Error(t("harness.errorInvalidInput"));
        const text: string[] = [],
          attachments: string[] = [];
        for (const item of params.input) {
          if (!isRecord(item)) throw Error(t("harness.errorInvalidInput"));
          if (item.type === "text" && typeof item.text === "string") {
            for (const match of item.text.matchAll(/^Attached file: ".*"\n([^\n]+)$/gm))
              attachments.push(materialId(match[1]!));
            text.push(item.text.replace(/^Attached file: ".*"\n[^\n]+$/gm, "").trim());
          } else if (item.type === "localImage" && typeof item.path === "string") attachments.push(item.path);
          else if (
            item.type === "image" &&
            typeof item.url === "string" &&
            /^(https:\/\/|\/api\/chat-materials\/original\?)/i.test(item.url)
          )
            attachments.push(materialId(item.url));
          else throw Error(t("harness.errorCapabilityUnavailable"));
        }
        const clientId = String(params.clientUserMessageId || crypto.randomUUID());
        if (!requests.has(clientId)) requests.set(clientId, crypto.randomUUID());
        const result = await api<{ runId: string }>(`${conversationsPath}/${id}/runs`, "POST", {
          requestId: requests.get(clientId),
          clientId,
          text: text.join("\n\n"),
          attachmentIds: attachments,
          model: params.model,
          effort: params.effort,
        });
        return { turn: { id: result.runId, status: "inProgress", items: [] } };
      }
      if (method === "turn/interrupt") return api(`${conversationsPath}/${id}/cancel`, "POST", {});
      if (method === "thread/name/set")
        return {
          thread: presentation(
            await api<HarnessSnapshot>(`${conversationsPath}/${id}`, "PATCH", { title: params.name }),
          ),
        };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "thread/queue/list") return { queuedSubmissions: [] };
      throw Error(t("harness.errorCapabilityUnavailable"));
    },
  };
  let lastSignature = "";
  let lastTitle = "";
  async function poll() {
    const id = current(),
      generation = epoch;
    try {
      if (id && document.visibilityState !== "hidden") {
        const result = await snapshot(id);
        if (generation !== epoch || current() !== id) return;
        const signature = `${id}:${result.cursor}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          const thread = presentation(result),
            turn = thread.turns.at(-1);
          if (thread.tokenUsage)
            options.emit({
              type: "engine/notification",
              payload: {
                method: "thread/tokenUsage/updated",
                params: { threadId: thread.id, tokenUsage: thread.tokenUsage },
              },
            });
          if (thread.name && `${id}:${thread.name}` !== lastTitle) {
            lastTitle = `${id}:${thread.name}`;
            options.emit({
              type: "engine/notification",
              payload: { method: "thread/name/updated", params: { threadId: thread.id, threadName: thread.name } },
            });
          }
          if (turn)
            options.emit({
              type: "engine/notification",
              payload: {
                method: turn.status === "inProgress" ? "turn/started" : "turn/completed",
                params: { threadId: thread.id, turn },
              },
            });
          if (turn?.status === "inProgress")
            for (const item of turn.items)
              options.emit({
                type: "engine/notification",
                payload: {
                  method: item.status && item.status !== "inProgress" ? "item/completed" : "item/started",
                  params: { threadId: thread.id, turnId: turn.id, item },
                },
              });
          sync();
        }
        renderPermissions(result);
      }
    } catch (error) {
      if (current() === id) options.notices.addPersistentError(error, { key: "harness-read" });
    } finally {
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    }
  }
  function renderPermissions(snapshot: HarnessSnapshot) {
    let host = document.querySelector<HTMLElement>("#harnessInteractions");
    if (!host) {
      host = document.createElement("div");
      host.id = "harnessInteractions";
      host.className = "harness-interactions";
      document.querySelector("#composer")!.before(host);
    }
    const uncertain = snapshot.run?.status === "uncertain" && snapshot.conversation.activeRunId === snapshot.run.id;
    const signature = JSON.stringify([snapshot.conversation.id, snapshot.permissions, uncertain]);
    const prefix = `${snapshot.conversation.id}:`,
      present = new Set(snapshot.permissions.map((permission) => prefix + permission.id)),
      detailsState = new Map(
        [...host.querySelectorAll<HTMLDetailsElement>("[data-permission-details]")].map((details) => [
          details.dataset.permissionDetails,
          { open: details.open, scroll: details.querySelector("pre")?.scrollTop ?? 0 },
        ]),
      );
    for (const key of permissionSubmissions)
      if (key.startsWith(prefix) && !present.has(key)) permissionSubmissions.delete(key);
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    setMessageHtml(
      host,
      `${uncertain ? `<p role="status">${escapeHtml(t("harness.uncertain"))}</p><button class="wb-button" type="button" data-harness-recover>${escapeHtml(t("harness.recover"))}</button>` : ""}${snapshot.permissions
        .map((permission) => harnessPermissionCard(permission, t, permissionSubmissions.has(prefix + permission.id)))
        .join("")}`,
    );
    for (const details of host.querySelectorAll<HTMLDetailsElement>("[data-permission-details]")) {
      const saved = detailsState.get(details.dataset.permissionDetails);
      if (!saved) continue;
      details.open = saved.open;
      const content = details.querySelector("pre");
      if (content) content.scrollTop = saved.scroll;
    }
    host
      .querySelector<HTMLButtonElement>("[data-harness-recover]")
      ?.addEventListener(
        "click",
        () =>
          void api(`${conversationsPath}/${snapshot.conversation.id}/recover`, "POST", {}).catch((error) =>
            options.notices.addPersistentError(error),
          ),
      );
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-harness-permission]"))
      button.onclick = () => {
        const requestId = button.dataset.harnessPermission!,
          key = prefix + requestId,
          card = button.closest<HTMLElement>("[data-harness-permission-card]")!,
          controls = [...card.querySelectorAll<HTMLButtonElement>("[data-harness-permission]")],
          status = card.querySelector<HTMLElement>("[data-permission-status]")!;
        if (permissionSubmissions.has(key)) return;
        permissionSubmissions.add(key);
        card.setAttribute("aria-busy", "true");
        status.hidden = false;
        for (const control of controls) control.disabled = true;
        void api(`${conversationsPath}/${snapshot.conversation.id}/permissions`, "POST", {
          id: requestId,
          optionId: button.dataset.harnessOption ?? null,
        }).catch((error) => {
          permissionSubmissions.delete(key);
          host.removeAttribute("data-signature");
          const visibleCard = [...host.querySelectorAll<HTMLElement>("[data-harness-permission-card]")].find(
            (value) => value.dataset.harnessPermissionCard === requestId,
          );
          visibleCard?.setAttribute("aria-busy", "false");
          const visibleStatus = visibleCard?.querySelector<HTMLElement>("[data-permission-status]");
          if (visibleStatus) visibleStatus.hidden = true;
          for (const control of visibleCard?.querySelectorAll<HTMLButtonElement>("[data-harness-permission]") ?? [])
            control.disabled = false;
          options.notices.addPersistentError(error);
        });
      };
  }
  function bind() {
    if (ready) return;
    ready = true;
    trigger.onclick = () => {
      if (!panel.hidden) return close();
      scope = context();
      renderMenu();
      panel.hidden = false;
      mountSessionMenu(panel, trigger, close);
      trigger.setAttribute("aria-expanded", "true");
      panel.querySelector<HTMLButtonElement>("[data-harness-select]")?.focus();
    };
    bindMenuDismiss(panel, trigger, close);
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !event.composedPath().includes(trigger) && !event.composedPath().includes(panel)) close();
    });
    options.subscribe((change) => {
      if (["active", "newSessionProjectId"].includes(change.field)) {
        if (!state.active && previousActive) {
          selectedExplicitly = false;
          selected = catalog?.defaultRuntimeId ?? "";
        }
        previousActive = state.active?.id ?? "";
        epoch++;
        sync();
        if (!current()) document.querySelector("#harnessInteractions")?.replaceChildren();
      }
    });
    window.addEventListener("panda-force:harness-runtimes-updated", () => {
      void loadCatalog().catch(() => {});
    });
    void loadCatalog().catch(() => {});
    void poll();
  }
  return {
    boundary,
    bind,
    sync,
    localize() {
      sync();
      if (!panel.hidden) renderMenu();
      lastSignature = "";
      document.querySelector<HTMLElement>("#harnessInteractions")?.removeAttribute("data-signature");
    },
    close,
    destroy() {
      disposed = true;
      epoch++;
      if (timer) clearTimeout(timer);
      panel.remove();
    },
  };
}
