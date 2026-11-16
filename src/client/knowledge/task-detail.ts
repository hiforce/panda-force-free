import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeDraftInput } from "../../shared/knowledge/contracts.js";
import type { KnowledgeTask, KnowledgeTaskDetail } from "../../shared/knowledge/tasks.js";
import { setMessageHtml } from "../i18n.js";
import { knowledgeApi, knowledgeRequest, KnowledgeApiError } from "./api.js";
import { readKnowledgeDetail } from "./read-detail.js";
import { escapeHtml } from "../../shared/html.js";
import { knowledgeDetailHtml, knowledgeEditHtml, knowledgeTaskLabel } from "./views.js";
import { KnowledgePreviousView } from "./previous-view.js";

export function editableKnowledgeDraft(detail: KnowledgeTaskDetail): KnowledgeDraftInput {
  return {
    ...detail.draft!,
    claims: detail.draft!.claims.map((claim) => ({
      ...claim,
      evidence: claim.evidence.map(({ sourceId, version, quote, start, section }) => ({
        sourceId,
        version,
        quote,
        start,
        ...(section === undefined ? {} : { section }),
      })),
    })),
  };
}

/** Task polling reads metadata; full evidence loads only when a selected phase or draft revision changes. */
export class KnowledgeTaskDetailView {
  private epoch = 0;
  private signature = "";
  private taskId = "";
  private detail: KnowledgeTaskDetail | null = null;
  private editing = false;
  private busy = false;
  private previous: KnowledgePreviousView | null = null;
  private loading: Promise<void> | null = null;
  constructor(
    private readonly host: HTMLElement,
    private readonly t: Translate,
    private readonly signal: AbortSignal,
    private readonly changed: (task: KnowledgeTask) => void,
    private readonly error: (error: unknown) => void,
  ) {}
  get canNavigate() {
    return !this.editing && !this.busy;
  }
  clear() {
    this.epoch++;
    this.signature = "";
    this.taskId = "";
    this.detail = null;
    this.previous = null;
    this.loading = null;
    this.host.replaceChildren(
      Object.assign(document.createElement("p"), { textContent: this.t("knowledge.selectTask") }),
    );
  }
  select(task: KnowledgeTask, force = false): Promise<void> {
    const signature = JSON.stringify([
      task.id,
      task.state,
      task.generation,
      task.reviewRevision,
      task.updatedAt,
      task.automaticReview?.id,
      task.automaticReview?.state,
    ]);
    if (!force && task.id === this.taskId && (this.editing || this.busy)) return Promise.resolve();
    if (!force && signature === this.signature) return this.loading ?? Promise.resolve();
    this.taskId = task.id;
    this.signature = signature;
    this.editing = false;
    const pending = this.render(task),
      settled = () => {
        if (this.loading === pending) this.loading = null;
      };
    this.loading = pending;
    void pending.then(settled, settled);
    return pending;
  }
  private async render(task: KnowledgeTask) {
    const epoch = ++this.epoch,
      restoreFocus = this.host.querySelector("[data-knowledge-detail-retry]") === document.activeElement;
    this.host.replaceChildren(Object.assign(document.createElement("p"), { textContent: this.t("knowledge.loading") }));
    let detail: KnowledgeTaskDetail, review: Awaited<ReturnType<typeof knowledgeApi.review>>;
    try {
      ({ detail, review } = await readKnowledgeDetail(task.id, this.signal));
    } catch (error) {
      if (this.signal.aborted || epoch !== this.epoch) return;
      this.signature = "";
      setMessageHtml(
        this.host,
        `<p role="status">${escapeHtml(this.t(error instanceof KnowledgeApiError && error.code === "conflict" ? "knowledge.conflict" : "knowledge.unavailable"))}</p><button type="button" class="wb-button" data-knowledge-detail-retry>${escapeHtml(this.t("common.retry"))}</button>`,
      );
      this.host.querySelector<HTMLButtonElement>("[data-knowledge-detail-retry]")!.onclick = () =>
        void this.select(task, true).catch(this.error);
      this.lock(this.busy);
      if (restoreFocus)
        this.host.querySelector<HTMLElement>("[data-knowledge-detail-retry]")?.focus({ preventScroll: true });
      return;
    }
    if (this.signal.aborted || epoch !== this.epoch) return;
    this.detail = detail;
    setMessageHtml(this.host, knowledgeDetailHtml(detail, review, this.t));
    const previousHost = this.host.querySelector<HTMLElement>("[data-knowledge-previous]");
    this.previous =
      previousHost && detail.previous
        ? new KnowledgePreviousView(previousHost, detail.task.id, detail.previous, this.t, this.signal, () =>
            this.lock(this.busy),
          )
        : null;
    const form = this.host.querySelector<HTMLFormElement>("[data-knowledge-answer]");
    if (form)
      form.onsubmit = (event) => {
        event.preventDefault();
        void this.run(async () => {
          const answers = detail.dialogue.questions
            .filter((q) => !detail.dialogue.answers.some((a) => a.questionId === q.id))
            .map((q) => ({
              questionId: q.id,
              answer: (form.elements.namedItem("pf-knowledge-answer-" + q.id) as HTMLTextAreaElement).value,
            }));
          await this.action("answer", { answers });
        });
      };
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-knowledge-action]"))
      button.onclick = () =>
        void this.run(async () => {
          const action = button.dataset.knowledgeAction!;
          if (action === "edit") return this.beginEditing();
          await this.action(
            action,
            action === "approve"
              ? {
                  revision: detail.task.reviewRevision,
                  ...(this.previous?.acknowledgement ? { previousState: this.previous.acknowledgement } : {}),
                }
              : {},
          );
        });
    this.host.querySelector<HTMLElement>("[data-knowledge-task-state]")?.setAttribute("aria-live", "polite");
    this.lock(this.busy);
    if (restoreFocus)
      this.host
        .querySelector<HTMLElement>("button:not([disabled]),input:not([disabled]),textarea:not([disabled])")
        ?.focus({ preventScroll: true });
  }
  private async run(work: () => Promise<void>) {
    if (this.busy || this.signal.aborted) return;
    this.busy = true;
    this.host.setAttribute("aria-busy", "true");
    this.lock(true);
    try {
      await work();
    } catch (error) {
      if (!this.signal.aborted) this.error(error);
    } finally {
      this.busy = false;
      this.lock(false);
      this.host.removeAttribute("aria-busy");
    }
  }
  private lock(value: boolean) {
    for (const element of this.host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>(
      "button,input,textarea",
    ))
      element.disabled = value;
    this.previous?.lock(value);
    const approve = this.host.querySelector<HTMLButtonElement>('[data-knowledge-action="approve"]');
    if (approve && this.detail?.previous?.reviewRequired) approve.disabled = value || !this.previous?.acknowledgement;
  }
  private async action(action: string, body: Record<string, unknown>) {
    const id = this.taskId,
      response = await knowledgeRequest<{ task: KnowledgeTask }>(
        "/tasks/" + action,
        "POST",
        { id, ...body },
        this.signal,
      );
    if (this.signal.aborted || id !== this.taskId) return;
    this.editing = false;
    await this.select(response.task, true);
    this.changed(response.task);
  }
  private async beginEditing() {
    if (!this.detail?.draft) return;
    // Claim human editing before displaying inputs, fencing an automatic reviewer that is still running.
    const id = this.taskId,
      initial = editableKnowledgeDraft(this.detail),
      response = await knowledgeRequest<{ task: KnowledgeTask }>(
        "/tasks/edit",
        "POST",
        { id, revision: this.detail.task.reviewRevision, draft: initial },
        this.signal,
      );
    if (this.signal.aborted || id !== this.taskId) return;
    this.detail = { ...this.detail, task: response.task };
    this.editing = true;
    this.changed(response.task);
    const target = this.host.querySelector<HTMLElement>("[data-knowledge-draft]")!;
    setMessageHtml(target, knowledgeEditHtml(this.detail, this.t));
    this.host.querySelector("[data-knowledge-task-actions]")?.replaceChildren();
    const state = this.host.querySelector<HTMLElement>("[data-knowledge-task-state]");
    if (state) state.textContent = knowledgeTaskLabel(response.task, this.t);
    const form = target.querySelector<HTMLFormElement>("form")!;
    form.onsubmit = (event) => {
      event.preventDefault();
      void this.run(async () => {
        const value = (name: string) =>
          (form.elements.namedItem("pf-knowledge-" + name) as HTMLInputElement | HTMLTextAreaElement).value;
        const draft = {
          ...initial,
          title: value("title"),
          summary: value("summary"),
          claims: initial.claims.map((claim, i) => ({ ...claim, text: value("claim-" + i) })),
        };
        await this.action("edit", { revision: response.task.reviewRevision, draft });
      });
    };
    target.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  }
}
