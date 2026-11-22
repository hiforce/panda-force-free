import type { CreationTaskView } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import {
  setMessageHtml,
  errorText,
  messageHtml,
  messageAttributes,
  getBrowserI18n,
  localizeText,
  localizeAttribute,
} from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { creationApiFor, CreationApiError } from "./api.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { aggregateCreationActivity, type ActivityTask } from "./activity-model.js";
import { CreationHistoryControl } from "./history-control.js";
import { creationRecordTitle } from "./record-view.js";
import { creationRecordView } from "./record-view.js";
import { createHorizontalCarousel } from "../horizontal-carousel.js";

import { creationStateMessage } from "./state.js";
export { creationStateLabels } from "./state.js";
export const creationActive = (task: CreationTaskView) =>
  !task.failure && ["queued", "running", "committing"].includes(task.state);
/** Both entry pages share owner-scoped records; the modal and native thread are never the navigation identity. */
export class CreationActivity {
  private readonly history: CreationHistoryControl;
  private historyRevision = 0;
  private historyBefore = 0;
  private carousel?: ReturnType<typeof createHorizontalCarousel>;
  private visible = false;
  private timer?: ReturnType<typeof setTimeout>;
  private loading = false;
  private tasks: ActivityTask[] = [];
  private filter = "all";
  private query = "";
  private expanded = false;
  private signature = "";
  private locale = "";
  private readonly cacheKey: string;
  private readonly unsubscribe: () => void;
  private readonly changed = () => {
    if (this.visible) void this.refresh();
  };
  private readonly visibilityChanged = () => {
    if (this.visible && !document.hidden) void this.refresh();
  };
  private disposed = false;
  constructor(
    private readonly host: HTMLElement,
    private readonly t: Translate,
    identity: string,
    private readonly projects: () => { id: string; name: string }[],
    private readonly navigate: (path: string) => void,
    private readonly options: { limit?: number; presentation?: "cards" | "sidebar" } = {},
  ) {
    host.classList.add("creation-activity");
    this.cacheKey = STORAGE_KEYS.creationSnapshotFor(identity, "list");
    const cached = storage.getSessionJson(this.cacheKey, null);
    if (cached && Date.now() - cached.at < 300000 && Array.isArray(cached.tasks))
      this.tasks = aggregateCreationActivity(cached.tasks);
    if (cached && Number.isSafeInteger(cached.before)) this.historyBefore = cached.before;
    this.history = new CreationHistoryControl(
      identity,
      () => {
        this.historyRevision++;
        this.signature = "";
        this.render();
        this.paintHistory();
        if (this.visible && !this.history.waiting) void this.refresh();
      },
      (scope, taskId) => {
        this.tasks = this.tasks.filter(
          (row) => row.scope !== scope || (taskId !== undefined && row.task.id !== taskId),
        );
        storage.removeSession(this.cacheKey);
      },
      () => this.historyBefore || Math.max(0, ...this.tasks.map(({ task }) => task.createdAt + 1)),
    );
    this.unsubscribe = getBrowserI18n().subscribe(() => {
      if (this.visible) {
        this.locale = document.documentElement.lang;
        this.signature = "";
        this.render();
      }
    });
    window.addEventListener("panda-force:creation-changed", this.changed);
    document.addEventListener("visibilitychange", this.visibilityChanged);
  }
  show() {
    if (this.disposed) return;
    const language = document.documentElement.lang;
    if (this.locale !== language) {
      this.locale = language;
      this.layout();
      this.signature = "";
      this.render();
    }
    if (this.visible) return;
    this.visible = true;
    void this.refresh();
  }
  setPresentation(presentation: "cards" | "sidebar") {
    if (this.options.presentation === presentation && this.host.dataset.presentation === presentation) return;
    this.options.presentation = presentation;
    this.host.dataset.presentation = presentation;
    this.locale = document.documentElement.lang;
    this.layout();
    this.signature = "";
    this.render();
  }
  hide() {
    this.visible = false;
    clearTimeout(this.timer);
  }
  accept(scope: ActivityTask["scope"], value: CreationTaskView) {
    const {
      id,
      projectId,
      state,
      generation,
      prompt,
      goal,
      model,
      effort,
      cancelRequested,
      artifact,
      failure,
      question,
      createdAt,
      updatedAt,
      previousTaskId,
      creation,
      document,
      documentStatus,
    } = value;
    const task: CreationTaskView = {
      id,
      projectId,
      state,
      generation,
      prompt,
      goal,
      model,
      effort,
      cancelRequested,
      artifact,
      failure,
      question,
      createdAt,
      updatedAt,
      previousTaskId,
      creation,
      document,
      documentStatus,
    };
    let changed = false;
    this.tasks = this.tasks.map((row) => {
      if (row.scope !== scope || row.task.id !== task.id || row.task.updatedAt > task.updatedAt) return row;
      changed = true;
      return { scope, task };
    });
    if (changed && this.visible) this.render();
  }
  dispose() {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    this.unsubscribe();
    this.history.dispose();
    this.carousel?.dispose();
    window.removeEventListener("panda-force:creation-changed", this.changed);
    document.removeEventListener("visibilitychange", this.visibilityChanged);

    this.host.classList.remove("creation-activity");
  }
  private layout() {
    this.carousel?.dispose();
    this.carousel = undefined;
    const t = this.t;
    setMessageHtml(
      this.host,
      `<div class="creation-activity-toolbar"><div class="creation-activity-filters" role="group" ${messageAttributes("aria-label", "creation.activityFilter", {}, t)}>${(["all", "active", "completed", "attention"] as const).map((key) => `<button type="button" data-activity-filter="${key}" aria-pressed="${this.filter === key}" ${key === "attention" ? messageAttributes("aria-label", "creation.filterAttention", {}, t) + " " + messageAttributes("title", "creation.filterAttention", {}, t) : ""}>${key === "attention" ? codexIcon("circleAlert") : messageHtml(({ all: "creation.filterAll", active: "creation.filterActive", completed: "creation.filterCompleted" } as const)[key], {}, t)}</button>`).join("")}</div><div class="creation-activity-tools"><button type="button" data-activity-search-toggle aria-expanded="${!!this.query}" ${messageAttributes("aria-label", "creation.searchTasks", {}, t)} ${messageAttributes("title", "creation.searchTasks", {}, t)}>${codexIcon("search")}</button><button type="button" data-activity-refresh ${messageAttributes("aria-label", "creation.refresh", {}, t)} ${messageAttributes("title", "creation.refresh", {}, t)}>${codexIcon("refreshCw")}</button><button type="button" data-history-clear-all ${messageAttributes("aria-label", "creation.clearHistory", {}, t)} ${messageAttributes("title", "creation.clearHistory", {}, t)}>${codexIcon("trash")}</button></div></div><div class="creation-activity-search wb-form" ${this.query ? "" : "hidden"}><label class="wb-field"><span class="sr-only">${messageHtml("creation.searchTasks", {}, t)}</span><input type="search" data-activity-search ${messageAttributes("placeholder", "creation.searchTasks", {}, t)} value="${e(this.query)}"></label></div><p role="status" data-activity-status>${messageHtml("creation.activityLoading", {}, t)}</p><div data-activity-list></div><button type="button" class="creation-activity-more" data-activity-more hidden>${messageHtml("creation.showMoreTasks", {}, t)}${codexIcon("chevronDown")}</button>`,
    );
    if (this.options.presentation) {
      this.host.dataset.presentation = this.options.presentation;
      const filters = this.host.querySelector<HTMLElement>(".creation-activity-filters")!;
      const details = document.createElement("details"),
        summary = document.createElement("summary");
      details.className = "creation-record-filter-menu";
      setMessageHtml(
        summary,
        `${codexIcon("slidersHorizontal")}<span class="creation-record-filter-label">${messageHtml("creation.activityFilter", {}, t)}</span>${codexIcon("chevronDown")}`,
      );
      localizeAttribute(summary, "aria-label", "creation.activityFilter", {}, t);
      filters.before(details);
      details.append(summary, filters);
      for (const button of filters.querySelectorAll<HTMLButtonElement>("button")) {
        const key = button.dataset.activityFilter;
        localizeText(
          button,
          key === "active"
            ? "creation.filterActive"
            : key === "completed"
              ? "creation.filterCompleted"
              : key === "attention"
                ? "creation.filterAttention"
                : "creation.filterAll",
          {},
          t,
        );
        button.addEventListener("click", () => {
          details.open = false;
          summary.focus();
        });
      }
    }
    if (this.options.presentation === "cards") {
      const clear = this.host.querySelector<HTMLButtonElement>("[data-history-clear-all]")!;
      clear.classList.add("icon-button", "creation-history-all");
      this.host.append(clear);
      this.carousel = createHorizontalCarousel(this.host.querySelector<HTMLElement>("[data-activity-list]")!, t, {
        region: "creation.recentCreations",
        kind: "creation.carousel",
        previous: "creation.previousCreation",
        next: "creation.nextCreation",
      });
      this.host.append(this.carousel.controls);
    }
    this.host.querySelector<HTMLButtonElement>("[data-history-clear-all]")!.onclick = () =>
      void this.history.clear(undefined, () => this.historyFocus());
    this.paintHistory();
    this.host.querySelector<HTMLButtonElement>("[data-activity-refresh]")!.onclick = () => void this.refresh();
    const input = this.host.querySelector<HTMLInputElement>("input")!,
      toggle = this.host.querySelector<HTMLButtonElement>("[data-activity-search-toggle]")!,
      search = this.host.querySelector<HTMLElement>(".creation-activity-search")!;
    toggle.onclick = () => {
      search.hidden = !search.hidden;
      toggle.setAttribute("aria-expanded", String(!search.hidden));
      if (!search.hidden) input.focus();
    };
    input.oninput = () => {
      this.query = input.value;
      this.render();
    };
    input.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        search.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    };
    this.host.querySelector<HTMLButtonElement>("[data-activity-more]")!.onclick = () => {
      this.expanded = !this.expanded;
      this.render();
    };
    this.host.querySelectorAll<HTMLButtonElement>("[data-activity-filter]").forEach(
      (button) =>
        (button.onclick = () => {
          this.filter = button.dataset.activityFilter!;
          const summary = this.host.querySelector(".creation-record-filter-menu summary");
          if (summary) {
            const key =
              this.filter === "active"
                ? "creation.filterActive"
                : this.filter === "completed"
                  ? "creation.filterCompleted"
                  : this.filter === "attention"
                    ? "creation.filterAttention"
                    : "creation.filterAll";
            setMessageHtml(
              summary,
              `${codexIcon("slidersHorizontal")}<span class="creation-record-filter-label">${messageHtml(key, {}, this.t)}</span>${codexIcon("chevronDown")}`,
            );
            localizeAttribute(summary, "aria-label", key, {}, this.t);
          }
          this.host
            .querySelectorAll<HTMLElement>("[data-activity-filter]")
            .forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.activityFilter === this.filter)));
          this.render();
        }),
    );
    this.host.querySelector<HTMLElement>("[data-activity-list]")!.onclick = (event) => {
      const remove =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-history-clear]") : null;
      if (remove) {
        event.preventDefault();
        event.stopPropagation();
        void this.history.clear(
          { id: remove.dataset.historyClear!, scope: remove.dataset.scope as ActivityTask["scope"] },
          () =>
            this.host.querySelector(`[data-history-clear="${CSS.escape(remove.dataset.historyClear!)}"]`) ||
            this.historyFocus(),
        );
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-activity-task]") : null;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      this.navigate(this.path(row.dataset.activityTask!, row.dataset.scope!));
    };
  }
  private async refresh() {
    if (!this.visible || this.loading) return;
    this.loading = true;
    const historyRevision = this.historyRevision;
    clearTimeout(this.timer);
    const status = this.host.querySelector<HTMLElement>("[data-activity-status]")!,
      button = this.host.querySelector<HTMLButtonElement>("[data-activity-refresh]")!;
    button.disabled = true;
    if (this.tasks.length) status.hidden = true;
    try {
      const results = await Promise.allSettled(
        (["application", "personal"] as const).map(async (scope) => {
          const result = await creationApiFor(scope === "personal" ? "personal" : "").list("*");
          return { tasks: result.tasks.map((task) => ({ task, scope })), before: result.before };
        }),
      );
      if (!this.visible || historyRevision !== this.historyRevision) return;
      const boundaries = results.flatMap((result) =>
        result.status === "fulfilled" && Number.isSafeInteger(result.value.before) ? [result.value.before] : [],
      );
      if (boundaries.length) this.historyBefore = Math.max(...boundaries);
      const records = results
        .flatMap((result, index) =>
          result.status === "fulfilled"
            ? result.value.tasks
            : result.reason instanceof CreationApiError && [401, 403, 404].includes(result.reason.status)
              ? []
              : this.tasks.filter((row) => row.scope === (index ? "personal" : "application")),
        )
        .map((row) => {
          const known = this.tasks.find((existing) => existing.scope === row.scope && existing.task.id === row.task.id);
          return known && known.task.updatedAt > row.task.updatedAt
            ? { ...known, task: { ...known.task, creation: row.task.creation ?? known.task.creation } }
            : row;
        })
        .sort((a, b) => b.task.createdAt - a.task.createdAt);
      this.tasks = aggregateCreationActivity(records);
      const failed = results.some((result) => result.status === "rejected");
      localizeText(status, "creation.activityLoadFailed", {}, this.t);
      status.hidden = !failed;
      status.dataset.error = String(failed);
      this.render();
      if (!failed)
        storage.setSessionJson(this.cacheKey, { at: Date.now(), tasks: this.tasks, before: this.historyBefore });
      else if (
        results.some(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof CreationApiError &&
            [401, 403, 404].includes(result.reason.status),
        )
      )
        storage.removeSession(this.cacheKey);
    } catch (error) {
      status.textContent = errorText(
        error instanceof CreationApiError ? error.payload : null,
        this.t,
        "creation.activityLoadFailed",
      );
      status.dataset.error = "true";
      status.hidden = false;
    } finally {
      this.loading = false;
      this.paintHistory();
      button.disabled = false;
      if (this.visible)
        this.timer = setTimeout(
          () => {
            if (document.hidden) {
              this.timer = setTimeout(() => void this.refresh(), 5000);
            } else void this.refresh();
          },
          historyRevision !== this.historyRevision
            ? 0
            : this.tasks.some(({ task }) => creationActive(task))
              ? 2000
              : 10000,
        );
    }
  }
  private historyFocus() {
    const button = this.host.querySelector<HTMLElement>("[data-history-clear-all]");
    return button?.getClientRects().length ? button : document.querySelector<HTMLElement>("#prompt");
  }
  private paintHistory() {
    this.host.dataset.historyPending = String(this.history.resuming);
    this.host.dataset.historyBusy = String(this.history.waiting);
    const button = this.host.querySelector<HTMLButtonElement>("[data-history-clear-all]"),
      notice = this.history.notice;
    if (button) {
      const key = this.history.waiting
        ? "creation.clearingHistory"
        : this.history.resuming
          ? "creation.retryClearHistory"
          : "creation.clearHistory";
      button.disabled = this.history.waiting;
      localizeAttribute(button, "aria-label", key, {}, this.t);
      localizeAttribute(button, "title", key, {}, this.t);
      setMessageHtml(button, codexIcon(this.history.resuming ? "refreshCw" : "trash"));
    }
    if (notice) {
      const status = this.host.querySelector<HTMLElement>("[data-activity-status]");
      if (status) {
        localizeText(status, notice, {}, this.t);
        status.hidden = false;
        status.dataset.error = String(this.history.error && !this.history.waiting);
      }
    }
  }
  private path(id: string, scope: string) {
    return (
      "/creation/" +
      encodeURIComponent(id) +
      "?" +
      new URLSearchParams({ creationScope: scope, from: location.pathname === "/workspace" ? "workspace" : "create" })
    );
  }
  private render() {
    const list = this.host.querySelector<HTMLElement>("[data-activity-list]");
    if (!list) return;
    this.host.dataset.empty = String(!this.tasks.length);
    this.host.dataset.expanded = String(this.expanded);
    const query = this.query.trim().toLocaleLowerCase(),
      matches = this.tasks.filter(
        ({ task }) =>
          (!query ||
            [task.prompt, task.creation?.prompt, task.document?.title, task.artifact?.title].some((value) =>
              value?.toLocaleLowerCase().includes(query),
            )) &&
          (this.filter === "all" ||
            (this.filter === "active"
              ? creationActive(task)
              : this.filter === "completed"
                ? task.state === "succeeded" || task.state === "replied"
                : Boolean(task.failure) || ["failed", "cancelled"].includes(task.state))),
      ),
      limit = this.options.presentation === "cards" ? 8 : (this.options.limit ?? 4),
      shown = this.expanded ? matches : matches.slice(0, limit),
      signature = JSON.stringify([
        shown.map(({ task, scope }) => [
          task.id,
          scope,
          task.prompt,
          task.creation,
          task.artifact,
          task.document,
          task.state,
          task.question?.id,
          creationActive(task) ? task.createdAt : task.updatedAt,
        ]),
        this.filter,
        this.query,
        this.expanded,
        this.projects(),
        this.locale,
      ]);
    if (this.signature === signature) return;
    const focused =
      document.activeElement instanceof Element
        ? document.activeElement.closest<HTMLAnchorElement>("[data-activity-task]")?.dataset.activityTask
        : undefined;
    setMessageHtml(
      list,
      shown.length
        ? shown
            .map(
              ({ task, scope }) =>
                `<div class="creation-record-shell">${
                  this.options.presentation
                    ? creationRecordView(
                        task,
                        this.path(task.id, scope),
                        scope,
                        scope === "personal"
                          ? this.t("creation.personalDestination")
                          : this.projects().find((project) => project.id === task.projectId)?.name ||
                              this.t("creation.projectDestination"),
                        this.t(
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
                        this.locale || "en",
                        this.t,
                      )
                    : `<a class="creation-activity-row" href="${e(this.path(task.id, scope))}" data-activity-task="${e(task.id)}" data-scope="${scope}" data-state="${task.state}"><span class="creation-activity-icon">${codexIcon("file")}</span><span class="creation-activity-copy"><strong title="${e(task.creation?.prompt || task.prompt)}">${e(task.creation?.prompt || task.prompt)}</strong><span class="creation-activity-meta"><small>${e(scope === "personal" ? this.t("creation.personalDestination") : this.projects().find((project) => project.id === task.projectId)?.name || this.t("creation.projectDestination"))}</small><time>${e(new Intl.DateTimeFormat(this.locale || "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(task.createdAt))}</time></span><span class="creation-activity-state"><i></i>${e(this.t(task.goal?.status === "paused" ? "common.goalPaused" : task.question ? "creation.waiting" : task.failure ? (task.failure === "targetChanged" ? "creation.reviewRequired" : "creation.failed") : creationStateMessage(task)))}${task.creation && task.creation.rounds > 1 ? " · " + e(this.t("creation.roundCount", { count: task.creation.rounds })) : ""}</span></span>${codexIcon("chevronRight")}</a>`
                }<button type="button" class="creation-history-remove" data-history-clear="${e(task.id)}" data-scope="${scope}" ${messageAttributes("title", "creation.clearRecord", {}, this.t)} aria-label="${e(this.t("creation.clearRecord") + ": " + creationRecordTitle(task))}" ${this.history.blocked ? "disabled" : ""}>${codexIcon("trash")}</button></div>`,
            )
            .join("")
        : `<p class="creation-activity-empty">${e(this.t(this.query || this.filter !== "all" ? "creation.noTaskMatches" : "creation.empty"))}</p>`,
    );
    if (focused)
      list
        .querySelector<HTMLAnchorElement>(`[data-activity-task="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true });
    this.signature = signature;
    this.carousel?.refresh();
    const more = this.host.querySelector<HTMLButtonElement>("[data-activity-more]")!;
    more.hidden = matches.length <= limit;
    more.setAttribute("aria-expanded", String(this.expanded));
    const label = this.expanded
      ? this.options.presentation === "cards"
        ? "creation.collapseCreations"
        : "creation.showFewerTasks"
      : this.options.presentation === "cards"
        ? "creation.allCreations"
        : "creation.showMoreTasks";
    setMessageHtml(
      more,
      `<span class="creation-record-more-label">${messageHtml(label, {}, this.t)}</span>${codexIcon(this.expanded ? "chevronUp" : "chevronDown")}`,
    );
    localizeAttribute(more, "aria-label", label, {}, this.t);
    localizeAttribute(more, "title", label, {}, this.t);
  }
}
