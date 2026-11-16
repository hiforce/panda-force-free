import type { CreationTaskDetail, CreationTaskView } from "../../shared/creation/contracts.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { ActivityTask } from "./activity-model.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, errorText, messageHtml, messageAttributes, localizeText } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { creationApiFor, CreationApiError } from "./api.js";
import { CreationCards } from "./cards.js";
import { creationConversation, previousCreationRounds } from "./activity-conversation.js";

const states = {
  queued: "creation.queued",
  running: "creation.running",
  committing: "creation.committing",
  succeeded: "creation.succeeded",
  failed: "creation.failed",
  cancelled: "creation.cancelled",
} as const;
const stages: Record<string, MessageId> = {
  started: "creation.progressStarted",
  saving: "creation.progressSaving",
  waiting: "creation.waiting",
  answered: "creation.progressAnswered",
  message: "creation.progressMessage",
};
/** The page opens immediately; conversation history is fetched only after an explicit request. */
export class CreationActivityDetail {
  private readonly page = document.createElement("section");
  private cards?: CreationCards;
  private task?: CreationTaskDetail;
  private scope: ActivityTask["scope"] = "application";
  private id = "";
  private epoch = 0;
  private reads = 0;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private historyRequested = false;
  private historyReading = false;
  private showRefresh = false;
  private historyKey = "";
  private conversationMarkup = "";
  private processKey = "";
  private versionsMarkup = "";
  private readonly versions = new Map<string, CreationTaskView>();
  private tab = "progress";
  private returnPath = "/create";
  private readonly previous = new Map<string, { task: CreationTaskDetail; at: number }>();
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
    private readonly navigate: (path: string) => void,
  ) {
    this.page.className = "creation-detail-page";
  }
  show(host: HTMLElement, id: string, scope: ActivityTask["scope"]) {
    if (this.page.parentNode === host && this.id === id && this.scope === scope) return;
    this.hide();
    this.id = id;
    this.scope = scope;
    this.returnPath = new URL(location.href).searchParams.get("from") === "workspace" ? "/workspace" : "/create";
    this.historyRequested = false;
    this.historyReading = false;
    this.historyKey = "";
    this.conversationMarkup = "";
    this.processKey = "";
    this.versionsMarkup = "";
    this.versions.clear();
    this.previous.clear();
    this.tab = "progress";
    const t = this.t;
    setMessageHtml(
      this.page,
      `<nav class="creation-detail-back"><a href="${this.returnPath}" data-detail-back>${codexIcon("arrowLeft")}${messageHtml("creation.backToRecords", {}, t)}</a></nav><header class="creation-detail-heading"><div><h1 tabindex="-1">${messageHtml("creation.detailPageTitle", {}, t)}</h1><p data-detail-meta></p></div><button type="button" class="wb-button primary" data-detail-open hidden>${codexIcon("file")}${messageHtml("creation.openDocument", {}, t)}</button></header><div class="creation-detail-loading" data-detail-loading role="status" aria-live="polite"><span class="creation-detail-spinner" aria-hidden="true"></span><span data-detail-loading-text>${messageHtml("creation.detailLoading", {}, t)}</span></div><p role="status" data-detail-notice></p><div class="creation-detail-layout"><section class="creation-detail-main"><nav class="creation-detail-tabs" aria-label="${e(t("creation.detailPageTitle"))}"><button type="button" data-detail-tab="progress" aria-pressed="true">${messageHtml("creation.progressAndResults", {}, t)}</button><button type="button" data-detail-tab="conversation" aria-pressed="false">${messageHtml("creation.conversation", {}, t)}</button></nav><div data-detail-summary><p class="creation-detail-excerpt" data-detail-excerpt></p><details class="creation-detail-brief"><summary>${messageHtml("creation.viewBrief", {}, t)}</summary><p data-detail-brief></p></details></div><div data-detail-conversation hidden><p>${messageHtml("creation.historyOnDemand", {}, t)}</p></div><div data-detail-card></div><form class="wb-form creation-follow-up" hidden><label class="wb-field"><span>${messageHtml("creation.followUp", {}, t)}</span><textarea rows="3" maxlength="16000" required ${messageAttributes("placeholder", "creation.followUpHint", {}, t)}></textarea></label><div class="creation-follow-up-actions"><p>${messageHtml("creation.revisionHint", {}, t)}</p><button type="submit" class="wb-button primary">${messageHtml("creation.submitFollowUp", {}, t)}${codexIcon("arrowUp")}</button></div><p role="status" data-follow-up-status></p></form></section><aside class="creation-detail-results"><section class="creation-result-card"><h2>${messageHtml("creation.outputVersions", {}, t)}</h2><div data-detail-versions></div></section><section class="creation-result-card creation-activity-process"><h2>${messageHtml("creation.process", {}, t)}</h2><ol data-detail-progress></ol></section></aside></div>`,
    );
    host.replaceChildren(this.page);
    this.page.querySelector("h1")!.focus({ preventScroll: true });
    this.page.querySelector<HTMLButtonElement>("[data-detail-open]")!.onclick = () => this.openDocument();
    this.page.querySelectorAll<HTMLButtonElement>("[data-detail-tab]").forEach(
      (button) =>
        (button.onclick = () => {
          this.tab = button.dataset.detailTab!;
          this.historyRequested ||= this.tab === "conversation";
          this.selectTab();
          if (this.tab === "conversation") void this.loadConversation();
        }),
    );
    this.cards = new CreationCards(
      this.page.querySelector("[data-detail-card]")!,
      t,
      () => {
        this.processKey = "";
        void this.refresh();
      },
      () => this.openDocument(),
      () => {},
      this.api(),
      { brief: false, openAction: false },
    );
    const input = this.page.querySelector<HTMLTextAreaElement>(".creation-follow-up textarea")!,
      saved = storage.getJson(this.key(), { prompt: "", id: "" });
    input.value = typeof saved.prompt === "string" ? saved.prompt : "";
    input.readOnly = Boolean(saved.id);
    if (input.readOnly)
      localizeText(this.page.querySelector(".creation-follow-up button"), "creation.retrySubmission", {}, t);
    input.oninput = () => {
      if (!this.busy) storage.setJson(this.key(), { prompt: input.value, id: "" });
    };
    this.page.querySelector<HTMLFormElement>(".creation-follow-up")!.onsubmit = (event) => {
      event.preventDefault();
      void this.followUp();
    };
    const cached = storage.getSessionJson(this.cacheKey(), null),
      list = storage.getSessionJson(STORAGE_KEYS.creationSnapshotFor(this.identity, "list"), null);
    if (cached && Date.now() - cached.at < 300000 && cached.task?.id === id) this.accept(cached.task);
    else if (list && Date.now() - list.at < 300000 && Array.isArray(list.tasks)) {
      const preview = list.tasks.find((row: ActivityTask) => row.task?.id === id && row.scope === scope);
      if (preview) this.accept({ ...preview.task, progress: [], clarifications: [] });
    }
    void this.refresh(true);
  }

  hide() {
    this.epoch++;
    clearTimeout(this.timer);
    this.id = "";
    this.task = undefined;
    this.reading = false;
    this.showRefresh = false;
    this.page.remove();
  }
  private api() {
    return creationApiFor(this.scope === "personal" ? "personal" : "");
  }
  private key() {
    return STORAGE_KEYS.creationFollowUpFor(this.identity, this.scope, this.id);
  }
  private cacheKey() {
    return STORAGE_KEYS.creationSnapshotFor(this.identity, this.scope + ":" + this.id);
  }
  private openDocument() {
    if (this.task?.artifact)
      this.navigate(
        "/documents?" + new URLSearchParams({ project: this.task.projectId, document: this.task.artifact.documentId }),
      );
  }
  private selectTab() {
    this.page.dataset.tab = this.tab;
    this.page.querySelector<HTMLElement>("[data-detail-summary]")!.hidden = this.tab === "conversation";
    this.page.querySelector<HTMLElement>("[data-detail-conversation]")!.hidden = this.tab !== "conversation";
    this.loadingIndicator();
    this.page
      .querySelectorAll<HTMLButtonElement>("[data-detail-tab]")
      .forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.detailTab === this.tab)));
  }
  private loadingIndicator() {
    const phase =
      this.historyReading && !this.conversationMarkup && this.tab === "conversation"
        ? "history"
        : this.reading && this.showRefresh
          ? this.task
            ? "refreshing"
            : "loading"
          : "";
    const indicator = this.page.querySelector<HTMLElement>("[data-detail-loading]")!;
    indicator.hidden = !phase;
    indicator.dataset.phase = phase;
    if (phase)
      localizeText(
        this.page.querySelector("[data-detail-loading-text]"),
        phase === "history"
          ? "creation.conversationLoading"
          : phase === "refreshing"
            ? "creation.detailRefreshing"
            : "creation.detailLoading",
        {},
        this.t,
      );
  }
  async refresh(initial = false) {
    if (!this.id || !this.page.isConnected || this.reading) return;
    clearTimeout(this.timer);
    const epoch = this.epoch,
      read = ++this.reads;
    this.reading = true;
    this.showRefresh = initial || !this.task;
    this.loadingIndicator();
    try {
      const { task } = await this.api().progress(this.id);
      if (epoch !== this.epoch || read !== this.reads) return;
      this.page.querySelector<HTMLElement>("[data-detail-notice]")!.textContent = "";
      this.accept(task);
      storage.setSessionJson(this.cacheKey(), { at: Date.now(), task });
      if (this.tab === "conversation") void this.loadConversation();
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error instanceof CreationApiError && [401, 403, 404].includes(error.status)) {
        storage.removeSession(this.cacheKey());
        storage.removeSession(STORAGE_KEYS.creationSnapshotFor(this.identity, "list"));
        this.task = undefined;
        this.page.querySelector<HTMLButtonElement>("[data-detail-open]")!.hidden = true;
        this.page.querySelector<HTMLElement>("[data-detail-meta]")!.textContent = "";
        this.page.querySelector<HTMLElement>(".creation-detail-layout")!.hidden = true;
      }
      this.page.querySelector<HTMLElement>("[data-detail-notice]")!.textContent = errorText(
        error instanceof CreationApiError ? error.payload : null,
        this.t,
        "creation.activityLoadFailed",
      );
      const retry = document.createElement("button");
      retry.className = "wb-button";
      localizeText(retry, "common.retry", {}, this.t);
      retry.onclick = () => void this.refresh();
      this.page.querySelector("[data-detail-notice]")!.append(" ", retry);
    } finally {
      if (epoch === this.epoch) {
        this.reading = false;
        this.showRefresh = false;
        this.loadingIndicator();
        if (this.task && ["queued", "running", "committing"].includes(this.task.state))
          this.timer = setTimeout(() => void this.refresh(), document.hidden ? 10000 : 2000);
      }
    }
  }
  private accept(task: CreationTaskDetail) {
    this.task = task;
    this.page.querySelector<HTMLElement>(".creation-detail-layout")!.hidden = false;
    this.page.querySelector<HTMLElement>("[data-detail-brief]")!.textContent = task.prompt;
    this.page.querySelector<HTMLElement>("[data-detail-excerpt]")!.textContent = task.prompt;
    const meta = [
      this.t(task.question ? "creation.waiting" : states[task.state]),
      this.t(task.projectId === "personal" ? "creation.personalDestination" : "creation.projectDestination"),
      this.time(task.createdAt),
    ].join(" · ");
    this.page.querySelector<HTMLElement>("[data-detail-meta]")!.textContent = meta;
    this.page.querySelector<HTMLElement>("[data-detail-meta]")!.dataset.state = task.state;
    this.page.querySelector<HTMLButtonElement>("[data-detail-open]")!.hidden = !task.artifact;
    this.cards!.render([task]);
    this.page.querySelector<HTMLFormElement>(".creation-follow-up")!.hidden =
      task.state !== "succeeded" || !task.artifact;
    const key = JSON.stringify([task.progress, task.state, task.updatedAt, document.documentElement.lang]);
    if (this.processKey !== key) {
      this.processKey = key;
      this.renderProcess(task);
      this.renderVersions([task]);
    }
    this.selectTab();
  }
  private async loadConversation() {
    if (!this.task || !this.historyRequested || this.historyReading) return;
    const key = JSON.stringify([
      this.id,
      this.task.updatedAt,
      this.task.state,
      this.task.state === "succeeded" ? null : Math.floor(Date.now() / 2000),
      document.documentElement.lang,
    ]);
    if (this.historyKey === key) return;
    const epoch = this.epoch,
      host = this.page.querySelector<HTMLElement>("[data-detail-conversation]")!;
    this.historyReading = true;
    this.loadingIndicator();
    if (!host.querySelector("[data-conversation-round]")) host.textContent = "";
    try {
      const { task } = await this.api().detail(this.id);
      const rounds = await previousCreationRounds(task, this.api().detail, this.previous);
      if (epoch !== this.epoch) return;
      const markup = creationConversation(rounds, this.t);
      if (markup !== this.conversationMarkup) {
        setMessageHtml(host, markup);
        this.conversationMarkup = markup;
      }
      this.historyKey = key;
      this.renderVersions(rounds);
    } catch (error) {
      if (epoch !== this.epoch) return;
      // A transient background read must not replace content that is already being read.
      if (this.conversationMarkup && !(error instanceof CreationApiError && [401, 403, 404].includes(error.status)))
        return;
      this.conversationMarkup = "";
      this.historyKey = "";
      localizeText(host, "creation.historyUnavailable", {}, this.t);
      const retry = document.createElement("button");
      retry.className = "wb-button";
      localizeText(retry, "common.retry", {}, this.t);
      retry.onclick = () => void this.loadConversation();
      host.append(retry);
    } finally {
      if (epoch === this.epoch) {
        this.historyReading = false;
        this.loadingIndicator();
      }
    }
  }
  private time(at: number) {
    return new Intl.DateTimeFormat(document.documentElement.lang || "en", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(at);
  }
  private renderProcess(task: CreationTaskDetail) {
    const events = [
      { at: task.createdAt, label: this.t("creation.progressAccepted") },
      ...task.progress
        .filter((entry) => entry.stage !== "message")
        .map((entry) => ({ at: entry.at, label: this.t(stages[entry.stage]!) })),
      ...(["succeeded", "failed", "cancelled"].includes(task.state)
        ? [{ at: task.updatedAt, label: this.t(states[task.state]) }]
        : []),
    ];
    setMessageHtml(
      this.page.querySelector("[data-detail-progress]"),
      events
        .map((entry) => `<li><time>${e(this.time(entry.at))}</time><strong>${e(entry.label)}</strong></li>`)
        .join(""),
    );
  }
  private renderVersions(rounds: readonly CreationTaskView[]) {
    for (const round of rounds) this.versions.set(round.id, round);
    const markup = [...this.versions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(
        (version) =>
          `<a class="creation-output-version" data-version="${e(version.id)}" href="/creation/${encodeURIComponent(version.id)}?${new URLSearchParams({ creationScope: this.scope, from: this.returnPath.slice(1) })}" ${version.id === this.id ? 'aria-current="true"' : ""}>${codexIcon("file")}<span><strong>${messageHtml(version.previousTaskId ? "creation.previousRound" : "creation.initialCreation", {}, this.t)}</strong><time>${e(this.time(version.createdAt))}</time></span>${version.id === this.id ? `<small>${messageHtml("creation.currentOutput", {}, this.t)}</small>` : ""}</a>`,
      )
      .join("");
    if (markup !== this.versionsMarkup) {
      setMessageHtml(this.page.querySelector("[data-detail-versions]"), markup);
      this.versionsMarkup = markup;
    }
  }
  private async followUp() {
    if (this.busy || !this.task?.artifact) return;
    const input = this.page.querySelector<HTMLTextAreaElement>(".creation-follow-up textarea")!,
      prompt = input.value.trim();
    if (!prompt) return;
    const key = this.key(),
      saved = storage.getJson(key, { prompt: "", id: "" }),
      id = saved.prompt === prompt && typeof saved.id === "string" && saved.id ? saved.id : crypto.randomUUID(),
      notice = this.page.querySelector<HTMLElement>("[data-follow-up-status]")!,
      button = this.page.querySelector<HTMLButtonElement>(".creation-follow-up button")!,
      epoch = this.epoch;
    storage.setJson(key, { prompt, id });
    this.busy = true;
    button.disabled = true;
    input.readOnly = true;
    localizeText(notice, "creation.creating", {}, this.t);
    try {
      const result = await this.api().followUp(this.id, id, prompt);
      storage.remove(key);
      if (epoch === this.epoch)
        this.navigate(
          "/creation/" +
            encodeURIComponent(result.task.id) +
            "?" +
            new URLSearchParams({ creationScope: this.scope, from: this.returnPath.slice(1) }),
        );
    } catch (error) {
      if (
        error instanceof CreationApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        storage.setJson(key, { prompt, id: "" });
      if (epoch === this.epoch)
        notice.textContent = errorText(
          error instanceof CreationApiError ? error.payload : null,
          this.t,
          "creation.deliveryUncertain",
        );
    } finally {
      this.busy = false;
      button.disabled = false;
      input.readOnly = Boolean(storage.getJson(key, { id: "" }).id);
      localizeText(button, input.readOnly ? "creation.retrySubmission" : "creation.submitFollowUp", {}, this.t);
    }
  }
}
