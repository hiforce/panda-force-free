import type { CreationTaskView } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, errorText, messageHtml, messageAttributes, getBrowserI18n, localizeText } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { creationApiFor, CreationApiError } from "./api.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import type { ActivityTask } from "./activity-model.js";

export const creationStateLabels = {
  queued: "creation.queued",
  running: "creation.running",
  committing: "creation.committing",
  succeeded: "creation.succeeded",
  failed: "creation.failed",
  cancelled: "creation.cancelled",
} as const;
export const creationActive = (task: CreationTaskView) => ["queued", "running", "committing"].includes(task.state);
/** Both entry pages share owner-scoped records; the modal and native thread are never the navigation identity. */
export class CreationActivity {
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
    private readonly options: { limit?: number } = {},
  ) {
    host.classList.add("creation-activity");
    this.cacheKey = STORAGE_KEYS.creationSnapshotFor(identity, "list");
    const cached = storage.getSessionJson(this.cacheKey, null);
    if (cached && Date.now() - cached.at < 300000 && Array.isArray(cached.tasks)) this.tasks = cached.tasks;
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
  hide() {
    this.visible = false;
    clearTimeout(this.timer);
  }
  dispose() {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    this.unsubscribe();
    window.removeEventListener("panda-force:creation-changed", this.changed);
    document.removeEventListener("visibilitychange", this.visibilityChanged);

    this.host.classList.remove("creation-activity");
  }
  private layout() {
    const t = this.t;
    setMessageHtml(
      this.host,
      `<div class="creation-activity-toolbar"><div class="creation-activity-filters" role="group" ${messageAttributes("aria-label", "creation.activityFilter", {}, t)}>${(["all", "active", "completed", "attention"] as const).map((key) => `<button type="button" data-activity-filter="${key}" aria-pressed="${this.filter === key}" ${key === "attention" ? messageAttributes("aria-label", "creation.filterAttention", {}, t) + " " + messageAttributes("title", "creation.filterAttention", {}, t) : ""}>${key === "attention" ? codexIcon("circleAlert") : messageHtml(({ all: "creation.filterAll", active: "creation.filterActive", completed: "creation.filterCompleted" } as const)[key], {}, t)}</button>`).join("")}</div><div class="creation-activity-tools"><button type="button" data-activity-search-toggle aria-expanded="${!!this.query}" ${messageAttributes("aria-label", "creation.searchTasks", {}, t)} ${messageAttributes("title", "creation.searchTasks", {}, t)}>${codexIcon("search")}</button><button type="button" data-activity-refresh ${messageAttributes("aria-label", "creation.refresh", {}, t)} ${messageAttributes("title", "creation.refresh", {}, t)}>${codexIcon("refreshCw")}</button></div></div><div class="creation-activity-search wb-form" ${this.query ? "" : "hidden"}><label class="wb-field"><span class="sr-only">${messageHtml("creation.searchTasks", {}, t)}</span><input type="search" data-activity-search ${messageAttributes("placeholder", "creation.searchTasks", {}, t)} value="${e(this.query)}"></label></div><p role="status" data-activity-status>${messageHtml("creation.activityLoading", {}, t)}</p><div data-activity-list></div><button type="button" class="creation-activity-more" data-activity-more hidden>${messageHtml("creation.showMoreTasks", {}, t)}${codexIcon("chevronDown")}</button>`,
    );
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
          this.host
            .querySelectorAll<HTMLElement>("[data-activity-filter]")
            .forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.activityFilter === this.filter)));
          this.render();
        }),
    );
    this.host.querySelector<HTMLElement>("[data-activity-list]")!.onclick = (event) => {
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
    clearTimeout(this.timer);
    const status = this.host.querySelector<HTMLElement>("[data-activity-status]")!,
      button = this.host.querySelector<HTMLButtonElement>("[data-activity-refresh]")!;
    button.disabled = true;
    if (this.tasks.length) status.hidden = true;
    try {
      const results = await Promise.allSettled(
        (["application", "personal"] as const).map(async (scope) => {
          const result = await creationApiFor(scope === "personal" ? "personal" : "").list("*");
          return result.tasks.map((task) => ({ task, scope }));
        }),
      );
      if (!this.visible) return;
      this.tasks = results
        .flatMap((result, index) =>
          result.status === "fulfilled"
            ? result.value
            : result.reason instanceof CreationApiError && [401, 403, 404].includes(result.reason.status)
              ? []
              : this.tasks.filter((row) => row.scope === (index ? "personal" : "application")),
        )
        .sort(
          (a, b) =>
            Number(creationActive(b.task)) - Number(creationActive(a.task)) || b.task.createdAt - a.task.createdAt,
        );
      const failed = results.some((result) => result.status === "rejected");
      localizeText(status, "creation.activityLoadFailed", {}, this.t);
      status.hidden = !failed;
      status.dataset.error = String(failed);
      this.render();
      if (!failed) storage.setSessionJson(this.cacheKey, { at: Date.now(), tasks: this.tasks });
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
      button.disabled = false;
      if (this.visible)
        this.timer = setTimeout(
          () => {
            if (document.hidden) {
              this.timer = setTimeout(() => void this.refresh(), 5000);
            } else void this.refresh();
          },
          this.tasks.some(({ task }) => creationActive(task)) ? 2000 : 10000,
        );
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
    const query = this.query.trim().toLocaleLowerCase(),
      matches = this.tasks.filter(
        ({ task }) =>
          (!query || task.prompt.toLocaleLowerCase().includes(query)) &&
          (this.filter === "all" ||
            (this.filter === "active"
              ? creationActive(task)
              : this.filter === "completed"
                ? task.state === "succeeded"
                : ["failed", "cancelled"].includes(task.state))),
      ),
      shown = this.expanded ? matches : matches.slice(0, this.options.limit ?? 4),
      signature = JSON.stringify([shown, this.filter, this.query, this.expanded, this.projects(), this.locale]);
    if (this.signature === signature) return;
    setMessageHtml(
      list,
      shown.length
        ? shown
            .map(
              ({ task, scope }) =>
                `<a class="creation-activity-row" href="${e(this.path(task.id, scope))}" data-activity-task="${e(task.id)}" data-scope="${scope}" data-state="${task.state}"><span class="creation-activity-icon">${codexIcon("file")}</span><span class="creation-activity-copy"><strong title="${e(task.prompt)}">${e(task.prompt)}</strong><span class="creation-activity-meta"><small>${e(scope === "personal" ? this.t("creation.personalDestination") : this.projects().find((project) => project.id === task.projectId)?.name || this.t("creation.projectDestination"))}</small><time>${e(new Intl.DateTimeFormat(this.locale || "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(task.createdAt))}</time></span><span class="creation-activity-state"><i></i>${e(this.t(task.question ? "creation.waiting" : creationStateLabels[task.state]))}</span></span>${codexIcon("chevronRight")}</a>`,
            )
            .join("")
        : `<p class="creation-activity-empty">${e(this.t(this.query || this.filter !== "all" ? "creation.noTaskMatches" : "creation.empty"))}</p>`,
    );
    this.signature = signature;
    const more = this.host.querySelector<HTMLButtonElement>("[data-activity-more]")!;
    more.hidden = matches.length <= (this.options.limit ?? 4);
    localizeText(more, this.expanded ? "creation.showFewerTasks" : "creation.showMoreTasks", {}, this.t);
  }
}
