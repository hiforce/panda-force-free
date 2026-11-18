import { parkMessageComposer } from "../message-composer-placement.js";
import type {
  CreationSessionDomain,
  SessionControlView,
  SessionWorkspaceView,
} from "../contracts/session-workspace.js";
import type { CreationTaskDetail, CreationRequest } from "../../shared/creation/contracts.js";
import type { EngineItem } from "../../shared/engine/types.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { creationSessionRoute } from "./session-route.js";
import { creationApiFor, CreationApiError } from "./api.js";
import { CreationActivity, creationActive, creationStateLabels } from "./activity.js";
import { CreationCards } from "./cards.js";
import { previousCreationRounds } from "./activity-conversation.js";
import { documentTreeApi } from "../documents/authoring/tree-api.js";
import { CreationDrafts } from "./drafts.js";
import { sessionUsageView } from "../session-workspace/usage.js";
import { messageHtml, errorText, setMessageHtml, localizeAttribute, localizeText } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { escapeHtml as e } from "../../shared/html.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { buildComposerInput } from "../composer-attachments.js";
import { sessionSkillContext } from "../../shared/session-skills.js";
import { CreationSkillDiscovery } from "./skill-discovery.js";
import { defaultCreationEffort } from "../../shared/creation/effort.js";

export interface CreationWorkspaceBridge {
  controls(): SessionControlView;
  cwd(): string;
  openGoal(draft?: import("../../shared/engine/types.js").Goal): void;
  clear(): void;
  restoreDraft(): void;
  saveDraft(scope?: string): void;
  accepted(scope: string, nextScope: string, prompt: string, materialIds: readonly string[]): void;
  seedDraft(text: string, selections: NonNullable<CreationTaskDetail["selections"]>, allowEmpty?: boolean): void;
  render(item: EngineItem, turnId: string): void;
  preserve(render: () => void): void;
  reset(discovery?: boolean): void;
  changed(): void;
  selections(): readonly import("../../shared/creation/contracts.js").CreationSkillSelection[];
  selectSkill(selection: import("../../shared/creation/contracts.js").CreationSkillSelection): void;
}

/** Creation owns public task data; one shared composer, renderer, viewport and inspector own all interaction surfaces. */
export class CreationSessionWorkspace implements CreationSessionDomain {
  private route: ReturnType<typeof creationSessionRoute> = null;
  private task?: CreationTaskDetail;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private goalWriting = false;
  private goalRevision = 0;
  private pendingGoal?: import("../../shared/creation/contracts.js").CreationGoalCommand;
  private readonly sending = new Set<string>();
  private pending?: { id: string; request: CreationRequest | Record<string, unknown> };
  private model = "";
  private effort = "";
  private readonly previous = new Map<string, { task: CreationTaskDetail; at: number }>();
  private readonly rendered = new Map<string, string>();
  private readonly sections = document.createElement("div");
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
  private readonly versions = document.createElement("section");
  private readonly selectedDocument = document.createElement("section");
  private readonly brief = document.createElement("section");
  private sectionSignature = "";
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
    private readonly navigate: (path: string) => void,
    private readonly projects: () => { id: string; name: string; code?: string }[],
    private readonly bridge: CreationWorkspaceBridge,
  ) {
    this.home.className = "creation-session-home";
    this.composerHome.className = "creation-entry-composer";
    this.discovery = new CreationSkillDiscovery(t, bridge.selections, (selection) => {
      bridge.selectSkill(selection);
      this.discovery.update();
    });
    this.sections.className = "creation-session-sections";
    this.actions.className = "creation-session-actions";
    this.notice.className = "creation-session-notice";
    this.notice.setAttribute("role", "status");
    this.status.className = "creation-session-status";
    for (const section of [this.selectedDocument, this.versions, this.brief]) section.className = "session-section";
  }
  get key() {
    return this.route?.key || "";
  }
  get running() {
    return Boolean(this.task && creationActive(this.task));
  }
  private get api() {
    return creationApiFor(this.route?.scope === "personal" ? "personal" : "");
  }
  show() {
    const route = creationSessionRoute();
    if (!route) return;
    if (this.route?.key === route.key) {
      this.renderActions();
      this.discovery.update();
      return;
    }
    const root = document.querySelector<HTMLElement>("#conversation")!;
    // Keep the shared input connected while its previous discovery container is cleared.
    parkMessageComposer();
    if (!this.dock.isConnected) root.closest(".conversation-shell")!.append(this.dock);
    this.hide();
    this.route = route;
    const saved = storage.getJson(this.preferenceKey(), { model: "", effort: "", pending: null });
    this.model = typeof saved.model === "string" ? saved.model : "";
    this.effort = typeof saved.effort === "string" ? saved.effort : "";
    this.pending = saved.pending || undefined;
    this.pendingGoal = storage.getJson(this.preferenceKey() + ":goal", null) || undefined;
    this.bridge.clear();
    this.bridge.reset(!route.id);
    root.replaceChildren(this.notice);
    this.notice.textContent = "";
    this.bridge.restoreDraft();
    if (!route.id) {
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
          if (task && task.id !== this.route?.id && this.route) {
            this.bridge.accepted(this.route.key, `creation:${this.route.scope}:${task.id}`, "", []);
            this.navigate("/creation/" + encodeURIComponent(task.id) + "?creationScope=" + this.route.scope);
          } else void this.refresh();
        },
        () => this.openDocument(),
        () => {},
        this.api,
        { brief: false, openAction: false },
      );
      this.restoreSnapshot();
      void this.refresh();
    }
    if (this.pending || this.pendingGoal || !route.id) this.renderPending();
    this.renderActions();
    this.bridge.changed();
  }
  hide() {
    if (this.route) this.bridge.reset();
    this.epoch++;
    clearTimeout(this.timer);
    this.activity?.hide();
    this.discovery.hide();
    this.sections.replaceChildren();
    this.actions.remove();
    this.task = undefined;
    this.pendingGoal = undefined;
    this.goalWriting = false;
    this.route = null;
    this.reading = false;
    this.cards = undefined;
    this.previous.clear();
    this.rendered.clear();
    this.sectionSignature = "";
  }
  update() {
    this.discovery.update();
  }
  controls(): SessionControlView {
    const base = this.bridge.controls(),
      selected =
        base.models.find((model) => model.id === this.model) ||
        base.models.find((model) => model.id === base.model) ||
        base.models[0];
    const preferred = this.effort || (selected ? storage.get(STORAGE_KEYS.effortFor(selected.id)) : "") || "",
      effort = selected?.efforts.some((entry) => entry.id === preferred)
        ? preferred
        : defaultCreationEffort(selected?.efforts.map((entry) => entry.id) || [], selected?.defaultEffort);
    return {
      ...base,
      sessionId: this.key,
      model: selected?.id || "",
      effort,
      permission: "documents",
      settingsHint: "creation.nextRoundSettings",
      permissions: [],
    };
  }
  applyModel(model: string, effort: string) {
    const selected = this.controls().models.find((entry) => entry.id === model);
    if (!selected?.efforts.some((entry) => entry.id === effort)) throw new Error(this.t("errors.couldNotLoadModels"));
    this.model = model;
    this.effort = effort;
    this.persist();
    this.bridge.changed();
  }
  read(): SessionWorkspaceView {
    const task = this.task,
      control = this.controls();
    const project = task ? this.projects().find((p) => p.id === task.projectId) : null;
    return {
      id: this.key,
      contextKind: "creation",
      inspectorAvailable: Boolean(this.route?.id),
      title: task?.prompt.replace(/\s+/g, " ").slice(0, 90) || this.t("creative.create"),
      cwd: task?.workspaceDirectory || "",
      project: project
        ? { id: project.id, name: project.name, code: project.code || "" }
        : this.route?.scope === "personal"
          ? { id: "personal", name: this.t("creation.personalDestination"), code: "" }
          : null,
      status: task
        ? {
            state: task.question
              ? "question"
              : this.running
                ? "running"
                : task.state === "succeeded"
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
                    : creationStateLabels[task.state],
            ),
            detail: "",
            icon: task.question
              ? "messageSquare"
              : this.running
                ? "sparkles"
                : task.state === "succeeded"
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
    if (this.sections.parentNode !== host) host.replaceChildren(this.sections);
    if (this.route?.id) {
      this.ensureRecords("sidebar");
      if (this.records.parentNode !== this.sections) this.sections.prepend(this.records);
    }
    if (this.selectedDocument.parentNode !== this.sections)
      this.sections.append(this.selectedDocument, this.brief, this.versions);
    const saved = this.savedDocument(),
      selected =
        this.task?.document ||
        (saved?.artifact
          ? {
              ...saved.artifact,
              title: saved.artifact.title || saved.prompt.slice(0, 100),
              revision: saved.artifact.revision || 1,
            }
          : undefined);
    const signature = JSON.stringify([
      selected,
      this.task?.documentStatus,
      saved?.artifact?.file,
      [...this.previous.keys()],
      this.task?.goal,
      document.documentElement.lang,
    ]);
    if (signature !== this.sectionSignature) {
      this.sectionSignature = signature;
      this.selectedDocument.hidden = !selected;
      this.versions.hidden = !saved?.artifact;
      this.brief.hidden = !this.task;
      if (this.task) {
        setMessageHtml(
          this.brief,
          `<div class="session-section-heading"><h3>${messageHtml("creation.currentBrief", {}, this.t)}</h3></div><details><summary>${e(this.task.prompt.slice(0, 100))}${this.task.prompt.length > 100 ? "…" : ""}</summary><p class="creation-session-brief">${e(this.task.prompt)}</p></details><div class="creation-brief-actions"><button type="button" class="wb-button" data-creation-supplement>${messageHtml("creation.followUp", {}, this.t)}</button>${!this.task.goal ? `<button type="button" class="wb-button" data-creation-goal>${messageHtml("creation.createGoal", {}, this.t)}</button>` : ""}</div>`,
        );
        this.brief.querySelector<HTMLButtonElement>("button")!.onclick = () =>
          document.querySelector<HTMLTextAreaElement>("#prompt")!.focus();
        this.brief.querySelector<HTMLButtonElement>("[data-creation-goal]")?.addEventListener("click", () => {
          this.bridge.openGoal({
            threadId: this.key,
            goalId: "draft",
            objective: this.task!.prompt.slice(0, 16000),
            status: "draft",
            detail: this.t("creation.goalScope"),
          });
        });
      }
      if (selected) {
        const projectLabel =
            this.task?.document?.projectId === "personal"
              ? this.t("creation.personalDestination")
              : this.task?.document?.projectName,
          file = saved?.artifact?.file,
          locationOpen = this.selectedDocument.querySelector<HTMLDetailsElement>(".creation-file-location")?.open;
        setMessageHtml(
          this.selectedDocument,
          `<div class="session-section-heading"><h3>${messageHtml("creation.selectedDocument", {}, this.t)}</h3></div><p>${e(selected.title)}</p><p class="session-caption">${messageHtml(this.task?.artifact ? "creation.savedRevision" : "creation.basedOnRevision", { version: selected.revision }, this.t)}</p>${projectLabel ? `<p class="session-caption" data-creation-document-project>${messageHtml("creation.documentProject", { project: projectLabel }, this.t)}</p>` : ""}${this.task?.documentStatus === "unavailable" ? `<p class="session-caption" role="status">${messageHtml("creation.documentUnavailable", {}, this.t)}</p>` : ""}${file ? `<details class="creation-file-location"${locationOpen ? " open" : ""}><summary>${codexIcon("file")}<span class="creation-file-copy"><span>${messageHtml("creation.savedFile", {}, this.t)}</span><strong title="${e(file.path.split("/").at(-1) || "")}">${e(file.path.split("/").at(-1) || "")}</strong></span>${codexIcon("chevronDown")}</summary><p class="session-caption">${e(file.path)}</p></details>` : ""}`,
        );
        setMessageHtml(
          this.versions,
          `<div class="session-section-heading"><h3>${messageHtml("creation.outputVersions", {}, this.t)}</h3></div>${[
            ...this.previous.values(),
          ]
            .filter(({ task }) => task.artifact)
            .map(
              ({ task }) =>
                `<a class="creation-output-version" href="/creation/${encodeURIComponent(task.id)}?creationScope=${this.route?.scope}">${codexIcon("file")}<span><strong>${messageHtml("creation.savedRevision", { version: task.artifact!.revision || 1 }, this.t)}</strong><time>${e(new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "short", timeStyle: "short" }).format(task.createdAt))}</time></span></a>`,
            )
            .join("")}`,
        );
      }
    }
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
    storage.setJson(this.preferenceKey(), { model: this.model, effort: this.effort, pending: this.pending || null });
  }
  private renderActions() {
    if (!this.route) return;
    const parent = document.querySelector(".workspace-context-actions")!;
    if (this.actions.parentNode !== parent) parent.prepend(this.actions);
    const signature = JSON.stringify([
      this.route.id,
      this.task?.document || this.savedDocument()?.artifact,
      this.task?.documentStatus,
      document.documentElement.lang,
    ]);
    if (this.actions.dataset.signature === signature) return;
    this.actions.dataset.signature = signature;
    setMessageHtml(
      this.actions,
      `<a class="icon-button" href="/create" data-creation-new>${codexIcon("plus")}</a><a class="icon-button" href="/create?view=works" data-creation-works>${codexIcon("folderOpen")}</a>${this.task?.document || this.savedDocument()?.artifact ? `<button type="button" class="session-button primary" data-creation-open${this.task?.documentStatus === "unavailable" ? " disabled" : ""}>${codexIcon("file")}<span>${messageHtml("creation.openDocument", {}, this.t)}</span></button>` : ""}`,
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
    this.actions
      .querySelector<HTMLButtonElement>("[data-creation-open]")
      ?.addEventListener("click", () => this.openDocument());
  }
  private savedDocument() {
    return (
      [...this.previous.values()]
        .map((value) => value.task)
        .sort((a, b) => b.createdAt - a.createdAt)
        .find((task) => task.artifact) || this.task
    );
  }
  private openDocument() {
    if (this.task?.documentStatus === "unavailable") return;
    const saved = this.savedDocument();
    const document = this.task?.document || saved?.artifact;
    if (saved && document)
      this.navigate(
        "/documents?" +
          new URLSearchParams({
            project:
              document.projectId ?? saved.artifact?.location?.projectId ?? saved.artifact?.projectId ?? saved.projectId,
            document: document.documentId,
          }),
      );
  }
  async refresh() {
    if (!this.route?.id || this.reading) return;
    const epoch = this.epoch,
      id = this.route.id,
      api = this.api,
      goalRevision = this.goalRevision;
    this.reading = true;
    clearTimeout(this.timer);
    try {
      const { task } = await api.detail(id);
      if (epoch !== this.epoch || goalRevision !== this.goalRevision) return;
      const rounds = await previousCreationRounds(task, api.detail, this.previous);
      if (epoch !== this.epoch || goalRevision !== this.goalRevision) return;
      this.present(task, rounds);
      this.cache(task, rounds);
    } catch (error) {
      if (epoch !== this.epoch) return;
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
        this.task = undefined;
        this.rendered.clear();
        this.previous.clear();
        storage.removeSession(this.cacheKey());
        storage.removeSession(STORAGE_KEYS.creationSnapshotFor(this.identity, "list"));
        this.renderActions();
        this.bridge.clear();
        document.querySelector("#conversation")!.replaceChildren(this.notice);
        this.bridge.changed();
      }
    } finally {
      if (epoch === this.epoch) {
        this.reading = false;
        this.timer = setTimeout(() => void this.refresh(), document.hidden ? 10000 : this.running ? 1500 : 10000);
      }
    }
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
    const snapshot = { at: Date.now(), task: redact(task), rounds: rounds.map(redact) };
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
      if (saved && Date.now() - saved.at < 300000 && saved.task?.id === this.route?.id && Array.isArray(saved.rounds))
        this.present(saved.task, saved.rounds);
      else if (list && Date.now() - list.at < 300000 && Array.isArray(list.tasks)) {
        const found = list.tasks.find(
          (row: { task: CreationTaskDetail; scope: string }) =>
            row.task?.id === this.route?.id && row.scope === this.route?.scope,
        );
        if (found) {
          const task = { ...found.task, progress: [], clarifications: [] };
          this.present(task, [task]);
        }
      }
      if (this.task && !this.pending) {
        localizeText(this.notice, "creation.detailRefreshing", {}, this.t);
        this.notice.dataset.phase = "refreshing";
      }
    } catch {
      storage.removeSession(this.cacheKey());
      this.task = undefined;
      this.rendered.clear();
      this.previous.clear();
      this.bridge.clear();
      document.querySelector("#conversation")!.replaceChildren(this.notice, this.status);
    }
  }
  private present(task: CreationTaskDetail, rounds: CreationTaskDetail[]) {
    this.task = task;
    if (this.route) this.activity?.accept(this.route.scope, task);
    if (!this.model && task.model) this.model = task.model;
    if (!this.effort && task.effort) this.effort = task.effort;
    this.renderPending();
    for (const round of rounds) this.previous.set(round.id, { task: round, at: Date.now() });
    if (task.selections !== undefined) this.bridge.seedDraft("", task.selections);
    this.bridge.preserve(() => {
      for (const round of rounds) {
        const turn = "creation-" + round.id;
        const requestContent = buildComposerInput(round.prompt, round.attachments || []);
        requestContent.push({
          type: "text",
          text: sessionSkillContext(
            round.skillSummaries ||
              (round.selections || []).map((selection) => ({ selection, name: { en: selection.id } })),
            "",
          ),
        });
        this.message(
          {
            id: turn + "-request",
            type: "userMessage",
            content: requestContent,
            sentAt: round.createdAt / 1000,
          },
          turn,
        );
        const entries: Array<{ at: number; item: EngineItem }> = round.progress.flatMap((entry, index) =>
          entry.stage === "message" && entry.text
            ? [
                {
                  at: entry.at,
                  item: {
                    id: turn + "-" + (entry.id || index),
                    type: "agentMessage",
                    text: entry.text,
                    status: entry.streaming && creationActive(round) ? "inProgress" : "completed",
                    receivedAt: entry.at / 1000,
                  },
                },
              ]
            : [],
        );
        for (const message of round.messages || []) {
          const content = buildComposerInput(message.text, message.attachments);
          content.push({
            type: "text",
            text: sessionSkillContext(
              message.skillSummaries ||
                message.selections.map((selection) => ({ selection, name: { en: selection.id } })),
              "",
            ),
          });
          entries.push({
            at: message.createdAt,
            item: {
              id: turn + "-update-" + message.id,
              type: "userMessage",
              content,
              steer: true,
              delivery:
                message.state === "uncertain"
                  ? "unconfirmed"
                  : message.state === "received"
                    ? "creation-received"
                    : message.state === "dispatching"
                      ? "creation-delivering"
                      : "sent",
              sentAt: message.createdAt / 1000,
            },
          });
        }
        for (const [index, clarification] of round.clarifications.entries()) {
          entries.push({
            at: clarification.askedAt || round.createdAt,
            item: {
              id: turn + "-question-" + index,
              type: "agentMessage",
              text: clarification.questions.map((question) => question.question).join("\n\n"),
            },
          });
          if (clarification.answeredAt)
            entries.push({
              at: clarification.answeredAt,
              item: {
                id: turn + "-answer-" + index,
                type: "userMessage",
                steer: true,
                content: [
                  {
                    type: "text",
                    text: clarification.questions
                      .map((question) =>
                        question.isSecret
                          ? this.t("creation.privateAnswer")
                          : (clarification.answers[question.id]?.answers || []).join("\n"),
                      )
                      .join("\n\n"),
                  },
                ],
              },
            });
        }
        entries.sort((a, b) => a.at - b.at);
        for (const entry of entries) this.message(entry.item, turn);
        const stream = document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turn)}"] .turn-event-stream`);
        if (stream)
          for (const [index, entry] of entries.entries()) {
            const node = document.querySelector<HTMLElement>(
                `#conversation [data-item-id="${CSS.escape(String(entry.item.id))}"]`,
              ),
              before = stream.children[index] || null;
            if (node && before !== node) stream.insertBefore(node, before);
          }
      }
      const root = document.querySelector<HTMLElement>("#conversation")!;
      let anchor: ChildNode = this.notice;
      for (const round of rounds) {
        const turn = "creation-" + round.id;
        for (const node of [
          root.querySelector(`[data-item-id="${CSS.escape(turn + "-request")}"]`),
          root.querySelector(`[data-turn-id="${CSS.escape(turn)}"]`),
        ]) {
          if (!node || node.parentNode !== root) continue;
          if (anchor.nextSibling !== node) root.insertBefore(node, anchor.nextSibling);
          anchor = node;
        }
      }
      this.cards?.render([task]);
      document.querySelector("#conversation")!.append(this.status);
    });
    this.renderActions();
    this.bridge.changed();
  }
  private message(item: EngineItem, turn: string) {
    const signature = JSON.stringify(item);
    if (this.rendered.get(String(item.id)) === signature) return;
    this.rendered.set(String(item.id), signature);
    this.bridge.render(item, turn);
  }
  private renderPending() {
    this.notice.replaceChildren();
    this.notice.dataset.phase = this.pending ? "pending" : "idle";
    if (this.pendingGoal) {
      localizeText(this.notice, "creation.goalPending", {}, this.t);
      const retryGoal = document.createElement("button");
      retryGoal.type = "button";
      retryGoal.className = "session-text-button";
      retryGoal.disabled = this.goalWriting;
      localizeText(retryGoal, "common.retry", {}, this.t);
      retryGoal.onclick = () =>
        void this.goalCommand(this.pendingGoal!).catch((error) => {
          this.renderPending();
          this.notice.append(
            " ",
            errorText(error instanceof CreationApiError ? error.payload : null, this.t, "creation.taskActionFailed"),
          );
        });
      this.notice.append(" ", retryGoal);
    }
    if (!this.pending) return;
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
    const route = this.route,
      epoch = this.epoch;
    if (!route || this.sending.has(route.key)) return;
    const prompt = input.text || this.t("creation.attachmentBrief");
    const attachments = input.attachments.map((attachment) => ({ materialId: attachment.materialId! }));
    if (this.pending) {
      const request = this.pending.request;
      if (
        request.prompt !== prompt ||
        JSON.stringify(request.attachments) !== JSON.stringify(attachments) ||
        JSON.stringify(request.selections) !== JSON.stringify(input.selections)
      ) {
        this.renderPending();
        throw new Error(this.t("creation.pendingSubmission"));
      }
    } else {
      const control = this.controls(),
        id = crypto.randomUUID();
      const request = {
        id,
        prompt,
        selections: [...input.selections],
        attachments,
        model: control.model,
        effort: control.effort,
      };
      if (route.id) this.pending = { id, request };
      else {
        this.sending.add(route.key);
        try {
          const [options, tree] = await Promise.all([this.api.options(), documentTreeApi.read("personal")]);
          if (epoch !== this.epoch) return;
          if (!options.defaultProfileId) throw new Error(this.t("creation.unavailable"));
          this.pending = {
            id,
            request: {
              ...request,
              projectId: "personal",
              treeVersion: tree.version,
              parentId: null,
              locale: document.documentElement.lang,
              profileId: options.defaultProfileId,
            },
          };
        } finally {
          this.sending.delete(route.key);
        }
      }
      this.persist();
    }
    await this.dispatchPending();
  }
  private async dispatchPending() {
    const route = this.route,
      pending = this.pending,
      epoch = this.epoch;
    if (!route || !pending || this.sending.has(route.key)) return;
    const key = this.preferenceKey(),
      model = this.model,
      effort = this.effort,
      api = this.api;
    const clearPending = () => {
      const saved = storage.getJson(key, { model, effort, pending: null });
      if (saved.pending?.id === pending.id) storage.setJson(key, { ...saved, pending: null });
    };
    this.sending.add(route.key);
    this.renderPending();
    try {
      const result = route.id
        ? await api.message(route.id, { ...pending.request, id: pending.id })
        : await api.submit(pending.request as CreationRequest);
      clearPending();
      if (epoch === this.epoch && this.pending?.id === pending.id) this.pending = undefined;
      const materials = (pending.request.attachments || []) as readonly { materialId: string }[];
      this.bridge.accepted(
        route.key,
        `creation:${route.scope}:${result.task.id}`,
        String(pending.request.prompt),
        materials.map((entry) => entry.materialId),
      );
      if (epoch !== this.epoch) return;
      this.renderPending();
      if (result.task.id === route.id) await this.refresh();
      else this.navigate("/creation/" + encodeURIComponent(result.task.id) + "?creationScope=" + route.scope);
    } catch (error) {
      if (
        error instanceof CreationApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      ) {
        clearPending();
        if (epoch === this.epoch && this.pending?.id === pending.id) this.pending = undefined;
      }
      if (epoch === this.epoch) this.renderPending();
      throw error;
    } finally {
      this.sending.delete(route.key);
    }
  }
  goal(): import("../../shared/engine/types.js").Goal | null {
    const goal = this.task?.goal;
    return goal
      ? {
          threadId: this.key,
          goalId: goal.id,
          objective: goal.objective,
          status: goal.status,
          updatedAt: goal.updatedAt,
          detail: this.t("creation.goalScope"),
          progress: { completed: goal.status === "completed" ? 1 : 0, total: 1 },
        }
      : null;
  }
  async goalCommand(command: Parameters<CreationSessionDomain["goalCommand"]>[0]) {
    const route = this.route,
      task = this.task,
      epoch = this.epoch;
    if (!route?.id || !task) throw new Error(this.t("workbench.startATaskFirst"));
    if (this.goalWriting) throw new Error(this.t("creation.goalPending"));
    if (
      this.pendingGoal &&
      (command.action !== this.pendingGoal.action || command.objective !== this.pendingGoal.objective)
    )
      throw new Error(this.t("creation.goalPending"));
    const controls = this.controls();
    const request = this.pendingGoal || {
      id: crypto.randomUUID(),
      ...command,
      ...(["set", "create"].includes(command.action) ? { model: controls.model, effort: controls.effort } : {}),
    };
    this.pendingGoal = request;
    const key = this.preferenceKey() + ":goal";
    storage.setJson(key, request);
    this.goalWriting = true;
    this.renderPending();
    const clear = () => {
      if (storage.getJson(key, null)?.id === request.id) storage.remove(key);
      if (epoch === this.epoch) this.pendingGoal = undefined;
    };
    try {
      const result = await this.api.goal(route.id, request);
      clear();
      if (epoch !== this.epoch) return null;
      this.goalRevision++;
      this.renderPending();
      if (result.task.id !== route.id) {
        this.bridge.accepted(route.key, `creation:${route.scope}:${result.task.id}`, "", []);
        this.navigate("/creation/" + encodeURIComponent(result.task.id) + "?creationScope=" + route.scope);
        return null;
      }
      this.task = { ...task, ...result.task, goal: result.goal };
      this.bridge.changed();
      void this.refresh();
      return this.goal();
    } catch (error) {
      if (
        error instanceof CreationApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        clear();
      throw error;
    } finally {
      if (epoch === this.epoch) {
        this.goalWriting = false;
        this.renderPending();
        this.bridge.changed();
      }
    }
  }
  async stop() {
    if (!this.route?.id || !this.running) return;
    await this.api.cancel(this.route.id);
    await this.refresh();
  }
}
