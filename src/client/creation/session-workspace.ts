import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import { creationDocumentArtifact } from "../../shared/creation/contracts.js";
import { creativeKindIcons } from "../../shared/creative/file-types.js";
import type { RuntimeSelection } from "../../shared/engine/runtime-selection.js";
import { defaultRuntimeModel, runtimeModels } from "../../shared/engine/runtime-selection.js";
import type { HarnessRuntimeView } from "../../shared/harness/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import type {
  CreationSessionDomain,
  SessionControlView,
  SessionWorkspaceView,
} from "../contracts/session-workspace.js";
import { LazyCreativeAssetsPanel } from "../creative/assets-lazy.js";
import { runtimeModelCatalog } from "../harness/model-catalog.js";
import { errorText, localizeAttribute, localizeText, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { parkMessageComposer } from "../message-composer-placement.js";
import { sessionUsageView } from "../session-workspace/usage.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { creationActive, CreationActivity } from "./activity.js";
import { CreationApiError, creationApiFor } from "./api.js";
import { CreationCards } from "./cards.js";
import { CreationDrafts } from "./drafts.js";
import { CreationSessionCommands } from "./session-commands.js";
import { CreationSessionGoals } from "./session-goals.js";
import type { CreationWorkspaceBridge } from "./session-port.js";
import { CreationSessionPresenter } from "./session-presenter.js";
import { CreationSessionReader } from "./session-reader.js";
import { creationSessionRoute } from "./session-route.js";
import { CreationSessionSections } from "./session-sections.js";
import { CreationSessionState } from "./session-state.js";
import { CreationSkillDiscovery } from "./skill-discovery.js";
import { creationStateMessage } from "./state.js";
import { creationDocumentRoute } from "./delivery-route.js";

export type { CreationWorkspaceBridge } from "./session-port.js";

/** Creation owns public task data; one shared composer, renderer, viewport and inspector own all interaction surfaces. */
export class CreationSessionWorkspace implements CreationSessionDomain {
  private readonly state = new CreationSessionState();
  private readonly reader: CreationSessionReader;
  private readonly commands: CreationSessionCommands;
  private defaultRuntime?: Promise<string>;
  private readonly goals: CreationSessionGoals;
  private readonly presenter: CreationSessionPresenter;
  private readonly sectionView: CreationSessionSections;
  private assetViewer: LazyCreativeAssetsPanel | null = null;
  private readonly historyHost = document.createElement("div");
  private readonly historyButton = document.createElement("button");
  private readonly actions = document.createElement("nav");
  private activity?: CreationActivity;
  private readonly records = document.createElement("section");
  private readonly recordList = document.createElement("div");
  private readonly home = document.createElement("div");
  private readonly composerHome = document.createElement("div");
  private readonly dock = document.querySelector<HTMLElement>(".composer-dock")!;
  private readonly discovery: CreationSkillDiscovery;
  private cards?: CreationCards;
  private readonly status = document.createElement("div");
  private readonly notice = document.createElement("p");
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
    private readonly navigate: (path: string) => void,
    private readonly projects: () => { id: string; name: string; code?: string }[],
    private readonly bridge: CreationWorkspaceBridge,
  ) {
    this.presenter = new CreationSessionPresenter(this.bridge, this.notice, this.status, this.t);
    this.sectionView = new CreationSessionSections(this.state, {
      t: this.t,
      records: () => {
        this.ensureRecords("sidebar");
        return this.records;
      },
      savedDocument: () => this.savedDocument(),
      openGoal: (draft) => this.bridge.openGoal(draft),
    });
    this.reader = new CreationSessionReader(this.state, {
      api: () => this.api,
      present: (task, rounds) => this.present(task, rounds),
      cache: (task, rounds) => this.cache(task, rounds),
      paintEarlier: () => this.paintEarlier(),
      failed: (error) => this.readFailed(error),
      hidden: () => document.hidden,
    });
    const commandPorts: import("./session-commands.js").CommandPorts = {
      t: this.t,
      api: () => this.api,
      controls: () => this.controls(),
      persist: () => this.persist(),
      preferenceKey: () => this.preferenceKey(),
      refresh: () => this.refresh(),
      renderPending: () => {
        this.renderPending();
        this.bridge.changed();
      },
      navigate: this.navigate,
      bridge: this.bridge,
    };
    this.commands = new CreationSessionCommands(this.state, commandPorts, () => this.defaultRuntime);
    this.goals = new CreationSessionGoals(this.state, commandPorts);
    this.home.className = "creation-session-home";
    this.composerHome.className = "creation-entry-composer";
    this.discovery = new CreationSkillDiscovery(t, bridge.selections, (selection) => {
      bridge.selectSkill(selection);
      this.discovery.update();
    });
    this.sectionView.root.className = "creation-session-sections";
    this.actions.className = "creation-session-actions";
    this.historyHost.className = "creation-session-history";
    this.historyButton.type = "button";
    this.historyButton.className = "session-text-button";
    this.historyButton.dataset.creationEarlier = "";
    this.historyButton.onclick = () => void this.loadEarlier();
    this.historyHost.append(this.historyButton);
    this.historyHost.hidden = true;
    this.sectionView.versions.onclick = (event) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>("[data-creation-round]");
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      void this.openRound(link.dataset.creationRound!);
    };
    this.notice.className = "creation-session-notice";
    this.notice.setAttribute("role", "status");
    this.status.className = "creation-session-status";
    for (const section of [this.sectionView.selectedDocument, this.sectionView.versions, this.sectionView.brief])
      section.className = "session-section";
  }
  get key() {
    return this.state.route?.key || "";
  }
  get running() {
    return Boolean(this.state.task && creationActive(this.state.task));
  }
  get sending() {
    return this.state.sending.has(this.key);
  }
  private get api() {
    return creationApiFor(this.state.route?.scope === "personal" ? "personal" : "");
  }
  show() {
    const route = creationSessionRoute();
    if (!route) return;
    if (this.state.route?.key === route.key) {
      this.renderActions();
      this.discovery.update();
      return;
    }
    const root = document.querySelector<HTMLElement>("#conversation")!;
    // Keep the shared input connected while its previous discovery container is cleared.
    parkMessageComposer();
    if (!this.dock.isConnected) root.closest(".conversation-shell")!.append(this.dock);
    this.hide();
    this.state.route = route;
    const saved = storage.getJson(this.preferenceKey(), { runtimeId: "", model: "", effort: "", pending: null });
    this.state.runtimeId = typeof saved.runtimeId === "string" ? saved.runtimeId : "";
    this.state.runtimePreferenceSaved = !!this.state.runtimeId;
    this.state.runtime = undefined;
    if (route.id && !this.state.runtimeId) this.state.runtimeId = "codex";
    this.defaultRuntime = this.state.runtimeId
      ? undefined
      : runtimeModelCatalog(this.t)
          .list()
          .then((catalog) => catalog.defaultRuntimeId)
          .catch(() => "");
    void this.loadRuntime();
    this.state.model = typeof saved.model === "string" ? saved.model : "";
    this.state.effort = typeof saved.effort === "string" ? saved.effort : "";
    this.state.pending = saved.pending || undefined;
    this.state.pendingGoal = storage.getJson(this.preferenceKey() + ":goal", null) || undefined;
    this.bridge.clear();
    this.bridge.reset(!route.id);
    root.replaceChildren(this.historyHost, this.notice);
    this.notice.classList.remove("sr-only");
    setOpaqueText(this.notice, "");
    this.bridge.restoreDraft();
    if (!route.id) {
      if (!this.state.pending) this.commands.warmDestination();
      const legacy = new CreationDrafts(this.identity, "personal").load();
      const migrationKey = this.preferenceKey() + ":legacy-migrated";
      if (!storage.get(migrationKey)) {
        if (legacy) this.bridge.seedDraft(legacy.prompt, legacy.selections, true);
        storage.set(migrationKey, "true");
      }
      this.ensureRecords("cards");
      root.append(this.home);
      this.home.append(this.composerHome, this.records);
      this.composerHome.append(this.dock);
      this.discovery.show(this.home);
    } else {
      localizeText(this.notice, "creation.detailLoading", {}, this.t);
      this.notice.dataset.phase = "loading";
      root.append(this.status);
      this.cards = new CreationCards(
        this.status,
        this.t,
        (task) => {
          if (task && task.id !== this.state.route?.id && this.state.route) {
            this.bridge.accepted(this.state.route.key, `creation:${this.state.route.scope}:${task.id}`, "", []);
            this.navigate("/creation/" + encodeURIComponent(task.id) + "?creationScope=" + this.state.route.scope);
          } else void this.refresh();
        },
        () => this.openDocument(),
        () => {},
        this.api,
        { brief: false, openAction: false, progressDetails: false },
      );
      this.restoreSnapshot();
      void this.refresh();
    }
    if (this.state.pending || this.state.pendingGoal || !route.id) this.renderPending();
    this.renderActions();
    this.bridge.changed();
  }
  hide() {
    this.state.catalogEpoch++;
    if (this.state.route) this.bridge.reset();
    this.state.epoch++;
    this.state.historyController.abort();
    this.state.historyController = new AbortController();
    this.state.conversation.reset();
    this.state.historyCheckedAt = 0;
    this.state.historyLoading = false;
    this.state.historyFailed = false;
    this.historyHost.hidden = true;
    clearTimeout(this.state.timer);
    this.activity?.hide();
    this.discovery.hide();
    this.assetViewer?.close();
    this.sectionView.root.replaceChildren();
    this.actions.remove();
    this.state.task = undefined;
    this.state.pendingGoal = undefined;
    this.state.goalWriting = false;
    this.state.route = null;
    this.state.reading = false;
    this.cards?.dispose();
    this.cards = undefined;
    this.state.previous.clear();
    this.presenter.clear();
    this.sectionView.clear();
  }
  update() {
    this.discovery.update();
  }
  private async loadRuntime() {
    const current = ++this.state.catalogEpoch;
    try {
      const catalog = runtimeModelCatalog(this.t);
      let id = this.state.runtimeId;
      if (!id) id = (await this.defaultRuntime) || "";
      if (!id || current !== this.state.catalogEpoch) return;
      const runtime = await catalog.discover(id);
      if (current !== this.state.catalogEpoch || !this.state.route) return;
      this.state.runtimeId = id;
      this.state.runtime = runtime;
      this.bridge.changed();
    } catch {
      if (current === this.state.catalogEpoch) this.bridge.changed();
    }
  }
  controls(): SessionControlView {
    const base = this.bridge.controls(),
      models = this.state.runtime ? runtimeModels(this.state.runtime) : [],
      model = this.state.model || (this.state.runtime ? defaultRuntimeModel(this.state.runtime) : ""),
      effort = this.state.effort || models.find((entry) => entry.id === model)?.defaultEffort || "";
    return {
      ...base,
      runtimeId: this.state.runtimeId,
      models,
      sessionId: this.key,
      model,
      effort,
      permission: "documents",
      permissionOwner: "creation",
      hidePermissionSetting: true,
      settingsHint: "creation.nextRoundSettings",
      permissions: [],
    };
  }
  applyRuntimeSelection(selection: RuntimeSelection, runtime: HarnessRuntimeView) {
    if (this.running && selection.runtimeId !== this.state.runtimeId) throw new Error(this.t("harness.errorBusy"));
    this.state.catalogEpoch++;
    this.state.runtimeId = selection.runtimeId;
    this.state.runtime = runtime;
    this.state.runtimePreferenceSaved = true;
    this.state.model = selection.model;
    this.state.effort = selection.effort;
    this.persist();
    this.bridge.changed();
  }
  applyModel(model: string, effort: string) {
    const selected = this.controls().models.find((entry) => entry.id === model);
    if (!selected || (effort && !selected.efforts.some((entry) => entry.id === effort)))
      throw new Error(this.t("errors.couldNotLoadModels"));
    this.state.model = model;
    this.state.effort = effort;
    this.persist();
    this.bridge.changed();
  }
  read(): SessionWorkspaceView {
    const task = this.state.task,
      control = this.controls();
    const project = task ? this.projects().find((p) => p.id === task.projectId) : null;
    return {
      id: this.key,
      contextKind: "creation",
      inspectorAvailable: Boolean(this.state.route?.id),
      title: (task?.creation?.prompt || task?.prompt)?.replace(/\s+/g, " ").slice(0, 90) || this.t("creative.create"),
      cwd: task?.workspaceDirectory || "",
      project: project
        ? { id: project.id, name: project.name, code: project.code || "" }
        : this.state.route?.scope === "personal"
          ? { id: "personal", name: this.t("creation.personalDestination"), code: "" }
          : null,
      status: task
        ? {
            state: task.question
              ? "question"
              : this.running
                ? "running"
                : task.state === "succeeded" || task.state === "replied"
                  ? "completed"
                  : "idle",
            label: this.t(
              task.goal?.status === "paused"
                ? "common.goalPaused"
                : task.question
                  ? "creation.waiting"
                  : task.failure
                    ? task.failure === "targetChanged"
                      ? "creation.reviewRequired"
                      : "creation.failed"
                    : creationStateMessage(task),
            ),
            detail: "",
            icon: task.question
              ? "messageSquare"
              : this.running
                ? "sparkles"
                : task.state === "succeeded" || task.state === "replied"
                  ? "check"
                  : "info",
          }
        : null,
      elapsedMs: task ? Math.max(0, (this.running ? Date.now() : task.updatedAt) - task.createdAt) : null,
      usage: sessionUsageView(task?.usage),
      hasGoal: Boolean(task?.goal),
      goal: task?.goal ? { id: task.goal.id, status: task.goal.status } : null,
      modelLabel:
        control.models.find((entry) => entry.id === control.model)?.label || this.t("workbench.modelUnavailable"),
      effortLabel:
        control.models.find((entry) => entry.id === control.model)?.efforts.find((entry) => entry.id === control.effort)
          ?.label || "",
      permissionLabel: this.t("creation.documentAccess"),
    };
  }
  renderSections(host: HTMLElement) {
    this.sectionView.render(host);
  }
  private ensureRecords(presentation: "cards" | "sidebar") {
    this.records.className =
      presentation === "cards" ? "creation-session-recent" : "session-section creation-session-records";
    let heading = this.records.querySelector("h3");
    if (!heading) {
      const header = document.createElement("div");
      header.className = "session-section-heading";
      heading = document.createElement("h3");
      header.append(heading);
      this.records.append(header, this.recordList);
    }
    localizeText(heading, presentation === "cards" ? "creation.recentCreations" : "creation.activityTitle", {}, this.t);
    this.activity ??= new CreationActivity(this.recordList, this.t, this.identity, this.projects, this.navigate, {
      limit: 4,
      presentation,
    });
    this.activity.setPresentation(presentation);
    this.activity.show();
  }
  private preferenceKey() {
    return "panda-force-creation-session:" + JSON.stringify([this.identity, this.key]);
  }
  private persist() {
    storage.setJson(this.preferenceKey(), {
      runtimeId: this.state.runtimeId,
      model: this.state.model,
      effort: this.state.effort,
      pending: this.state.pending || null,
    });
  }
  private renderActions() {
    if (!this.state.route) return;
    const artifact = this.savedDocument()?.artifact,
      openLabel = artifact && artifact.kind !== "document" ? "creative.open" : "creation.openDocument",
      parent = document.querySelector(".workspace-context-actions")!;
    if (this.actions.parentNode !== parent) parent.prepend(this.actions);
    const signature = JSON.stringify([
      this.state.route.id,
      this.state.task?.document || this.savedDocument()?.artifact,
      this.state.task?.documentStatus,
      document.documentElement.lang,
    ]);
    if (this.actions.dataset.signature === signature) return;
    this.actions.dataset.signature = signature;
    setMessageHtml(
      this.actions,
      `<a class="icon-button" href="/create" data-creation-new>${codexIcon("plus")}</a><a class="icon-button" href="/create?view=works" data-creation-works>${codexIcon("folderOpen")}</a>${this.state.task?.document || this.savedDocument()?.artifact ? `<button type="button" class="session-button primary" data-creation-open${this.state.task?.documentStatus === "unavailable" ? " disabled" : ""}>${codexIcon(artifact && artifact.kind !== "document" ? creativeKindIcons[artifact.kind] : "file")}<span>${messageHtml(openLabel, {}, this.t)}</span></button>` : ""}`,
    );
    localizeAttribute(
      this.actions.querySelector("[data-creation-new]"),
      "aria-label",
      "creation.newCreation",
      {},
      this.t,
    );
    localizeAttribute(
      this.actions.querySelector("[data-creation-works]"),
      "aria-label",
      "creative.assetLibrary",
      {},
      this.t,
    );
    localizeAttribute(this.actions.querySelector("[data-creation-open]"), "aria-label", openLabel, {}, this.t);
    this.actions
      .querySelector<HTMLButtonElement>("[data-creation-open]")
      ?.addEventListener("click", () => this.openDocument());
  }
  private async openRound(id: string) {
    const round = this.state.previous.get(id)?.task,
      artifact = round?.artifact;
    if (!round || !artifact) return;
    if (artifact.kind !== "document") {
      this.assetViewer ??= new LazyCreativeAssetsPanel(this.t, "creationArtifactViewer", this.identity);
      const epoch = this.state.epoch;
      try {
        await this.assetViewer.follow(artifact.projectId, artifact.assetId, async () => {}, artifact.version);
      } catch {
        if (epoch === this.state.epoch) localizeText(this.notice, "documents.unavailable", {}, this.t);
      }
      return;
    }
    const node = document.querySelector<HTMLElement>(
      `#conversation [data-item-id="${CSS.escape("creation-" + id + "-request")}"]`,
    );
    if (node) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: "start" });
    }
  }
  private savedDocument() {
    return (
      [...this.state.previous.values()]
        .map((value) => value.task)
        .sort((a, b) => b.createdAt - a.createdAt)
        .find((task) => task.artifact) || this.state.task
    );
  }
  private openDocument() {
    if (this.state.task?.documentStatus === "unavailable") return;
    const saved = this.savedDocument();
    const artifact = saved?.artifact;
    if (artifact && artifact.kind !== "document") {
      this.assetViewer ??= new LazyCreativeAssetsPanel(this.t, "creationArtifactViewer", this.identity);
      const epoch = this.state.epoch;
      void this.assetViewer
        .follow(artifact.projectId, artifact.assetId, async () => {}, artifact.version)
        .catch(() => {
          if (epoch === this.state.epoch) localizeText(this.notice, "documents.unavailable", {}, this.t);
        });
      return;
    }
    const document = this.state.task?.document || creationDocumentArtifact(artifact);
    if (saved && document)
      this.navigate(
        creationDocumentRoute({
          projectId:
            document.projectId ??
            creationDocumentArtifact(saved.artifact)?.location?.projectId ??
            saved.artifact?.projectId ??
            saved.projectId,
          documentId: document.documentId,
        }),
      );
  }
  private readFailed(error: unknown) {
    this.notice.classList.remove("sr-only");
    this.notice.dataset.phase = "error";
    this.notice.textContent = errorText(
      error instanceof CreationApiError ? error.payload : null,
      this.t,
      "creation.activityLoadFailed",
    );
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "session-text-button";
    localizeText(retry, "common.retry", {}, this.t);
    retry.onclick = () => void this.refresh();
    this.notice.append(" ", retry);
    if (error instanceof CreationApiError && [401, 403, 404].includes(error.status)) {
      this.state.task = undefined;
      this.presenter.clear();
      this.state.previous.clear();
      this.state.conversation.reset();
      this.state.historyCheckedAt = 0;
      this.state.historyController.abort();
      this.state.historyController = new AbortController();
      storage.removeSession(this.cacheKey());
      storage.removeSession(STORAGE_KEYS.creationSnapshotFor(this.identity, "list"));
      this.renderActions();
      this.bridge.clear();
      this.historyHost.hidden = true;
      document.querySelector("#conversation")!.replaceChildren(this.historyHost, this.notice);
      this.bridge.changed();
    }
  }
  async refresh() {
    await this.reader.refresh();
  }
  private paintEarlier() {
    this.historyHost.hidden = !this.state.conversation.nextCursor;
    this.historyButton.disabled = this.state.historyLoading || this.state.reading;
    localizeText(
      this.historyButton,
      this.state.historyLoading
        ? "creation.loadingEarlier"
        : this.state.historyFailed
          ? "creation.retryEarlier"
          : "creation.loadEarlier",
      {},
      this.t,
    );
  }
  private async loadEarlier() {
    await this.reader.loadEarlier();
  }
  private cacheKey() {
    return STORAGE_KEYS.creationSnapshotFor(this.identity, "conversation:" + this.key);
  }
  private cache(task: CreationTaskDetail, rounds: CreationTaskDetail[]) {
    const redact = (round: CreationTaskDetail) => ({
      ...round,
      clarifications: round.clarifications.map((entry) => ({
        ...entry,
        answers: Object.fromEntries(
          entry.questions
            .filter((question) => !question.isSecret)
            .map((question) => [question.id, entry.answers[question.id]]),
        ),
      })),
    });
    const snapshot = {
      at: Date.now(),
      task: redact(task),
      rounds: rounds.map(redact),
      conversation: this.state.conversation.snapshot(),
      routeId: this.state.route?.id,
    };
    if (JSON.stringify(snapshot).length > 512000) return;
    const key = this.cacheKey(),
      indexKey = STORAGE_KEYS.creationSnapshotFor(this.identity, "conversation-index");
    const prior = storage.getSessionJson(indexKey, []);
    const index = (Array.isArray(prior) ? prior : []).filter((value) => typeof value === "string" && value !== key);
    index.push(key);
    while (index.length > 5) storage.removeSession(index.shift());
    storage.setSessionJson(indexKey, index);
    storage.setSessionJson(key, snapshot);
  }
  private restoreSnapshot() {
    try {
      const saved = storage.getSessionJson(this.cacheKey(), null);
      const list = storage.getSessionJson(STORAGE_KEYS.creationSnapshotFor(this.identity, "list"), null);
      if (
        saved &&
        Date.now() - saved.at < 300000 &&
        (saved.routeId === this.state.route?.id || saved.task?.id === this.state.route?.id) &&
        Array.isArray(saved.rounds)
      ) {
        this.state.conversation.restore(saved.conversation);
        this.present(saved.task, saved.rounds);
        this.paintEarlier();
      } else if (list && Date.now() - list.at < 300000 && Array.isArray(list.tasks)) {
        const found = list.tasks.find(
          (row: { task: CreationTaskDetail; scope: string }) =>
            row.task?.id === this.state.route?.id && row.scope === this.state.route?.scope,
        );
        if (found) {
          const task = { ...found.task, progress: [], clarifications: [] };
          this.present(task, [task]);
        }
      }
      if (this.state.task && !this.state.pending) {
        localizeText(this.notice, "creation.detailRefreshing", {}, this.t);
        this.notice.dataset.phase = "refreshing";
      }
    } catch {
      storage.removeSession(this.cacheKey());
      this.state.task = undefined;
      this.presenter.clear();
      this.state.previous.clear();
      this.bridge.clear();
      document.querySelector("#conversation")!.replaceChildren(this.historyHost, this.notice, this.status);
    }
  }
  private present(task: CreationTaskDetail, rounds: CreationTaskDetail[]) {
    const newlyCompleted =
      task.state === "succeeded" && (this.state.task?.id !== task.id || this.state.task?.state !== "succeeded");
    this.state.task = task;
    if (!this.state.runtimePreferenceSaved && task.runtimeId) {
      this.state.runtimeId = task.runtimeId;
      this.state.runtimePreferenceSaved = true;
      void this.loadRuntime();
    }
    if (this.state.route) this.activity?.accept(this.state.route.scope, task);
    if (!this.state.model && task.model) this.state.model = task.model;
    if (!this.state.effort && task.effort) this.state.effort = task.effort;
    this.renderPending();
    for (const round of rounds) this.state.previous.set(round.id, { task: round, at: Date.now() });
    if (task.selections !== undefined) this.bridge.seedDraft("", task.selections);
    this.presenter.render(task, rounds, this.cards);
    if (newlyCompleted) window.dispatchEvent(new Event("panda-force:notifications-changed"));
    this.renderActions();
    this.bridge.changed();
  }

  private renderPending() {
    this.notice.classList.toggle("sr-only", this.sending);
    if (this.sending) {
      if (this.notice.dataset.phase !== "sending") {
        this.notice.dataset.phase = "sending";
        localizeText(this.notice, "creation.creating", {}, this.t);
      }
      return;
    }
    setOpaqueText(this.notice, "");
    this.notice.dataset.phase = this.state.pending ? "pending" : "idle";
    const task = this.state.task;
    const began =
      task?.progress.findLast((event) => event.generation === task.generation && event.stage === "started")?.at ??
      task?.createdAt;
    if (task && began && creationActive(task) && !task.question && !this.state.pending && Date.now() - began >= 60000)
      localizeText(this.notice, "creation.longRunningHint", {}, this.t);
    if (this.state.pendingGoal) {
      localizeText(this.notice, "creation.goalPending", {}, this.t);
      const retryGoal = document.createElement("button");
      retryGoal.type = "button";
      retryGoal.className = "session-text-button";
      retryGoal.disabled = this.state.goalWriting;
      localizeText(retryGoal, "common.retry", {}, this.t);
      retryGoal.onclick = () =>
        void this.goalCommand(this.state.pendingGoal!).catch((error) => {
          this.renderPending();
          this.notice.append(
            " ",
            errorText(error instanceof CreationApiError ? error.payload : null, this.t, "creation.taskActionFailed"),
          );
        });
      this.notice.append(" ", retryGoal);
    }
    if (!this.state.pending) return;
    localizeText(this.notice, "creation.pendingSubmission", {}, this.t);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "session-text-button";
    localizeText(retry, "creation.retrySubmission", {}, this.t);
    retry.onclick = () =>
      void this.dispatchPending().catch((error) => {
        this.renderPending();
        this.notice.append(
          " ",
          errorText(error instanceof CreationApiError ? error.payload : null, this.t, "creation.taskActionFailed"),
        );
      });
    this.notice.append(" ", retry);
  }
  async submit(input: Parameters<CreationSessionDomain["submit"]>[0]) {
    await this.commands.submit(input);
  }
  private async dispatchPending() {
    await this.commands.dispatchPending();
  }
  goal() {
    return this.goals.goal();
  }
  async goalCommand(command: Parameters<CreationSessionDomain["goalCommand"]>[0]) {
    return this.goals.goalCommand(command);
  }
  async stop() {
    if (!this.state.route?.id || !this.running) return;
    const id = this.state.task?.id || this.state.route.id,
      epoch = this.state.epoch,
      api = this.api;
    const active = this.state.stopping.get(id);
    if (active) return active;
    const pending = (async () => {
      await api.cancel(id);
      if (epoch === this.state.epoch) await this.refresh();
    })().finally(() => this.state.stopping.delete(id));
    this.state.stopping.set(id, pending);
    return pending;
  }
}
