import type {
  CreationTaskView,
  CreationTaskDetail,
  CreationFailure,
  CreationArtifact,
} from "../../shared/creation/contracts.js";
import { creationProgressText } from "../../shared/creation/progress.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, errorText, messageHtml } from "../i18n.js";

import { createUserInputCard } from "../user-input.js";
import { creationStateMessage } from "./state.js";
import { creationApi, CreationApiError } from "./api.js";
import { appendCreationArtifact } from "./artifact-card.js";

const failures: Record<CreationFailure, MessageId> = {
  interrupted: "creation.failedInterrupted",
  timedOut: "creation.failedTimedOut",
  inactive: "creation.failedInactive",
  invalidOutput: "creation.failedInvalidOutput",
  targetChanged: "creation.failedTargetChanged",
  fileChanged: "creation.failedFileChanged",
  writeUnavailable: "creation.failedWriteUnavailable",
};
/** Cards update by task and question identity. Polling never replaces an unanswered form or the writing brief. */
export class CreationCards {
  private readonly cards = new Map<string, { node: HTMLElement; key: string }>();
  private readonly retries = new Map<string, string>();
  private readonly busy = new Set<string>();
  private readonly artifacts = new Map<HTMLElement, () => void>();
  constructor(
    private readonly host: HTMLElement,
    private readonly t: Translate,
    private readonly changed: (task?: CreationTaskView) => void,
    private readonly open: (artifact: CreationArtifact) => void,
    private readonly report: (reason: unknown) => void,
    private readonly api: typeof creationApi = creationApi,
    private readonly options: { brief?: boolean; openAction?: boolean; progressDetails?: boolean } = {},
  ) {}
  dispose() {
    for (const cleanup of this.artifacts.values()) cleanup();
    this.artifacts.clear();
    this.cards.clear();
  }
  render(tasks: readonly (CreationTaskView & Partial<Pick<CreationTaskDetail, "progress">>)[]) {
    for (const [id, card] of this.cards)
      if (!tasks.some((task) => task.id === id)) {
        this.artifacts.get(card.node)?.();
        this.artifacts.delete(card.node);
        card.node.remove();
        this.cards.delete(id);
      }
    if (!tasks.length) {
      this.host.textContent = this.t("creation.empty");
      return;
    }
    if (!this.cards.size) this.host.replaceChildren();
    tasks.forEach((task, index) => {
      const key = JSON.stringify([
          task.state,
          task.goal?.status,
          task.question?.id,
          task.failure,
          task.artifact,
          task.cancelRequested,
          task.generation,
        ]),
        previous = this.cards.get(task.id);
      const oldDetails = previous?.node.querySelector<HTMLDetailsElement>("[data-creation-progress] details"),
        oldOpen = oldDetails?.open,
        oldScroll = oldDetails?.querySelector("ol")?.scrollTop;
      let node = previous?.node;
      if (!node || previous?.key !== key) {
        if (node) {
          this.artifacts.get(node)?.();
          this.artifacts.delete(node);
        }
        const fresh = this.card(task);
        previous?.node.replaceWith(fresh);
        node = fresh;
        this.cards.set(task.id, { node, key });
      }
      const before = this.host.children[index] ?? null;
      if (before !== node) this.host.insertBefore(node, before);
      const progress = node.querySelector<HTMLElement>("[data-creation-progress]")!;
      if (task.progress?.length && this.options.progressDetails !== false) {
        let details = progress.querySelector<HTMLDetailsElement>("details");
        if (!details) {
          setMessageHtml(
            progress,
            `<details open><summary>${messageHtml("creation.progressDetails", {}, this.t)}</summary><ol class="creation-progress-list" tabindex="0"></ol></details>`,
          );
          details = progress.querySelector("details")!;
        }
        const list = details.querySelector<HTMLOListElement>("ol")!,
          rows = task.progress
            .filter((entry) => entry.stage !== "usage")
            .map((entry) => ({
              at: entry.at,
              text:
                entry.stage === "message" || entry.stage === "reply"
                  ? entry.text
                  : creationProgressText(
                      entry,
                      this.t,
                      !task.failure && ["queued", "running", "committing"].includes(task.state),
                    ),
            }))
            .filter((entry) => entry.text);
        const signature = JSON.stringify(rows);
        if (list.dataset.signature !== signature) {
          const scroll = list.scrollTop;
          list.replaceChildren(
            ...rows.map((entry) => {
              const li = document.createElement("li"),
                time = document.createElement("time"),
                text = document.createElement("span");
              time.dateTime = new Date(entry.at).toISOString();
              time.textContent = new Intl.DateTimeFormat(document.documentElement.lang || "en", {
                timeStyle: "medium",
              }).format(entry.at);
              text.textContent = entry.text!;
              li.append(time, text);
              return li;
            }),
          );
          list.dataset.signature = signature;
          list.scrollTop = scroll;
        }
        if (oldOpen !== undefined) details.open = oldOpen;
        if (oldScroll !== undefined && previous?.node !== node) list.scrollTop = oldScroll;
      }
      node.querySelector("header small")!.textContent = new Intl.DateTimeFormat(document.documentElement.lang || "en", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(task.createdAt);
    });
  }
  private card(task: CreationTaskView) {
    const node = document.createElement("article");
    node.className = "creation-task";
    node.dataset.creationTask = task.id;
    node.dataset.state = task.state;
    const t = this.t,
      button = (label: MessageId, action: string, extra = "") =>
        `<button type="button" class="wb-button ${extra}" data-creation-action="${action}">${messageHtml(label, {}, t)}</button>`;
    setMessageHtml(
      node,
      `<header><strong data-creation-state>${messageHtml(creationStateMessage(task), {}, t)}</strong><small>${e(new Intl.DateTimeFormat(document.documentElement.lang || "en", { dateStyle: "short", timeStyle: "short" }).format(task.createdAt))}</small></header>${this.options.brief === false ? "" : `<p class="creation-task-brief">${e(task.prompt)}</p>`}${task.failure ? `<p class="creation-task-failure">${messageHtml(failures[task.failure], {}, t)}</p>` : ""}<div data-creation-question></div><div data-creation-progress class="wb-form"></div><footer>${task.artifact && this.options.openAction !== false ? button(task.artifact.kind === "document" ? "creation.openDocument" : "creative.open", "open", "primary") : ""}${["queued", "running", "committing"].includes(task.state) && !task.cancelRequested ? button("creation.cancel", "cancel", "danger") : ""}${!task.artifact && (["failed", "cancelled"].includes(task.state) || (task.state === "committing" && task.failure)) ? button(task.goal?.status === "paused" ? "common.resumeGoal" : task.failure === "targetChanged" && (task.document || task.previousTaskId) ? "creation.retryLatest" : "creation.retry", "retry") : ""}<p data-task-error role="alert" hidden></p></footer>`,
    );
    node.onclick = (event) => {
      const trigger = (event.target as Element).closest<HTMLButtonElement>("[data-creation-action]");
      if (!trigger || trigger.disabled || this.busy.has(task.id)) return;
      if (trigger.dataset.creationAction === "open" && task.artifact) {
        this.open(task.artifact);
        return;
      }
      this.busy.add(task.id);
      trigger.disabled = true;
      this.changed();
      const operation =
        trigger.dataset.creationAction === "cancel"
          ? this.api.cancel(task.id)
          : this.api.retry(task.id, this.retries.get(task.id) ?? this.newRetry(task.id));
      void operation
        .then((result) => {
          this.retries.delete(task.id);
          this.changed(result.task);
        })
        .catch((error) => {
          const hint = node.querySelector<HTMLElement>("[data-task-error]")!;
          hint.hidden = false;
          hint.textContent = errorText(
            error instanceof CreationApiError ? error.payload : null,
            t,
            "creation.taskActionFailed",
          );
        })
        .finally(() => {
          this.busy.delete(task.id);
          trigger.disabled = false;
        });
    };
    if (task.artifact) {
      const content = document.createElement("div");
      node.querySelector("footer")!.before(content);
      this.artifacts.set(node, appendCreationArtifact(content, task.artifact, t));
      node.querySelector('footer [data-creation-action="open"]')?.remove();
    }
    if (task.question) {
      const question = task.question;
      node.querySelector("[data-creation-question]")!.append(
        createUserInputCard(
          { id: question.id, params: { questions: question.questions } },
          {
            t,
            respond: async (_id: string, result: { answers: unknown }) => {
              this.changed();
              try {
                const saved = await this.api.answer(question.id, result.answers);
                this.changed(saved.task);
              } catch (error) {
                throw new Error(
                  errorText(error instanceof CreationApiError ? error.payload : null, t, "creation.taskActionFailed"),
                  { cause: error },
                );
              }
            },
            onResolved: () => {},
            onError: this.report,
          },
        ),
      );
    }
    return node;
  }
  private newRetry(id: string) {
    const value = crypto.randomUUID();
    this.retries.set(id, value);
    return value;
  }
}
