import type { CreationTaskView, CreationTaskState, CreationFailure } from "../../shared/creation/contracts.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, errorText, messageHtml } from "../i18n.js";

import { createUserInputCard } from "../user-input.js";
import { creationApi, CreationApiError } from "./api.js";

const states: Record<CreationTaskState, MessageId> = {
  queued: "creation.queued",
  running: "creation.running",
  committing: "creation.committing",
  succeeded: "creation.succeeded",
  failed: "creation.failed",
  cancelled: "creation.cancelled",
};
const failures: Record<CreationFailure, MessageId> = {
  interrupted: "creation.failedInterrupted",
  timedOut: "creation.failedTimedOut",
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
  constructor(
    private readonly host: HTMLElement,
    private readonly t: Translate,
    private readonly changed: (task?: CreationTaskView) => void,
    private readonly open: (id: string) => void,
    private readonly report: (reason: unknown) => void,
    private readonly api: typeof creationApi = creationApi,
    private readonly options: { brief?: boolean; openAction?: boolean } = {},
  ) {}
  render(tasks: readonly CreationTaskView[]) {
    for (const [id, card] of this.cards)
      if (!tasks.some((task) => task.id === id)) {
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
          task.artifact?.documentId,
          task.cancelRequested,
          task.generation,
        ]),
        previous = this.cards.get(task.id);
      let node = previous?.node;
      if (!node || previous?.key !== key) {
        const fresh = this.card(task);
        previous?.node.replaceWith(fresh);
        node = fresh;
        this.cards.set(task.id, { node, key });
      }
      const before = this.host.children[index] ?? null;
      if (before !== node) this.host.insertBefore(node, before);
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
      `<header><strong data-creation-state>${messageHtml(task.goal?.status === "paused" ? "common.goalPaused" : task.question ? "creation.waiting" : task.failure ? (task.failure === "targetChanged" ? "creation.reviewRequired" : "creation.failed") : states[task.state], {}, t)}</strong><small>${e(new Intl.DateTimeFormat(document.documentElement.lang || "en", { dateStyle: "short", timeStyle: "short" }).format(task.createdAt))}</small></header>${this.options.brief === false ? "" : `<p class="creation-task-brief">${e(task.prompt)}</p>`}${task.failure ? `<p class="creation-task-failure">${messageHtml(failures[task.failure], {}, t)}</p>` : ""}<div data-creation-question></div><footer>${task.artifact && this.options.openAction !== false ? button("creation.openDocument", "open", "primary") : ""}${["queued", "running", "committing"].includes(task.state) && !task.cancelRequested ? button("creation.cancel", "cancel", "danger") : ""}${!task.artifact && (["failed", "cancelled"].includes(task.state) || (task.state === "committing" && task.failure)) ? button(task.goal?.status === "paused" ? "common.resumeGoal" : task.failure === "targetChanged" && (task.document || task.previousTaskId) ? "creation.retryLatest" : "creation.retry", "retry") : ""}<p data-task-error role="alert" hidden></p></footer>`,
    );
    node.onclick = (event) => {
      const trigger = (event.target as Element).closest<HTMLButtonElement>("[data-creation-action]");
      if (!trigger || trigger.disabled || this.busy.has(task.id)) return;
      if (trigger.dataset.creationAction === "open" && task.artifact) {
        this.open(task.artifact.documentId);
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
