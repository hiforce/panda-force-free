import { KnowledgeTaskViews } from "./view.js";
export { knowledgeTaskView } from "./view.js";
import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeTaskInput, KnowledgeTask, KnowledgeTaskDetail } from "../../../shared/knowledge/tasks.js";
import {
  knowledgeDialogue,
  knowledgeId,
  knowledgeObject,
  knowledgeDigest,
} from "../../../shared/knowledge/task-validation.js";
import { validateKnowledgeEvidence } from "../evidence.js";
import { taskKnowledgeContext, knowledgeContextWithPrevious } from "./evidence-context.js";
import { readTaskPrevious, previousRecord, previousTextChunk } from "./previous.js";
import { knowledgeMarkdown } from "./markdown.js";
import { KnowledgeApprovals } from "./approvals.js";
import { KnowledgeTaskSubmission } from "./submission.js";
import { knowledgeTaskHistory } from "./history.js";
import type { KnowledgeReviewStore } from "../review/contracts.js";

import {
  KnowledgeTaskError,
  type KnowledgeContent,
  type KnowledgeTaskFiles,
  type KnowledgeSubmissionAdmission,
} from "./contracts.js";
import type { KnowledgeTaskStore } from "./contracts.js";
export class KnowledgeTasks {
  private readonly views: KnowledgeTaskViews;
  private readonly approvals: KnowledgeApprovals;
  private readonly submissions: KnowledgeTaskSubmission;
  constructor(
    private readonly ledger: Pick<
      MetadataStore<KnowledgeTaskStore>,
      | "get"
      | "list"
      | "page"
      | "submission"
      | "create"
      | "answer"
      | "edit"
      | "admit"
      | "cancel"
      | "retry"
      | "retryOutput"
    >,
    private readonly files: KnowledgeTaskFiles,
    private readonly content: KnowledgeContent,
    profile: () => Promise<KnowledgeTaskInput["profile"]>,
    private readonly output: {
      reconcile(owner: string, id: string): Promise<void>;
    },
    private readonly execution: {
      wake(): void;
      interrupt(owner: string, id: string): void;
    },
    private readonly now: () => number = Date.now,
    reviews?: Pick<MetadataStore<KnowledgeReviewStore>, "latest" | "latestFor">,
  ) {
    this.views = new KnowledgeTaskViews(reviews);
    this.approvals = new KnowledgeApprovals(ledger, files, content, output, undefined, now);
    this.submissions = new KnowledgeTaskSubmission(ledger, files, content, profile, execution, now);
  }
  async submit(owner: string, value: unknown, admission?: KnowledgeSubmissionAdmission): Promise<KnowledgeTask> {
    return await this.views.one(await this.submissions.submit(owner, value, admission));
  }
  async list(owner: string, project: string) {
    knowledgeId(project);
    await this.content.authorize(owner, project);
    const tasks = await this.views.page(owner, await this.ledger.list(owner, project));
    await this.content.authorize(owner, project);
    return tasks;
  }
  history(owner: string, project: string, cursor?: string) {
    return knowledgeTaskHistory(
      this.ledger,
      this.content,
      (tasks) => this.views.page(owner, tasks),
      owner,
      project,
      cursor,
    );
  }
  private async authorized(owner: string, id: string) {
    const task = await this.ledger.get(owner, knowledgeId(id));
    await this.content.authorize(owner, task.project);
    return task;
  }
  async status(owner: string, id: string) {
    return await this.views.one(await this.authorized(owner, id));
  }
  async detail(owner: string, id: string): Promise<KnowledgeTaskDetail> {
    const task = await this.authorized(owner, id),
      [input, dialogue, draft] = await Promise.all([
        this.files.input(task.inputDigest),
        this.files.dialogue(task.dialogueDigest),
        task.draftDigest ? this.files.draft(task.draftDigest) : null,
      ]),
      previous = await readTaskPrevious(this.files, input),
      context = knowledgeContextWithPrevious(input, dialogue, previous),
      sourceCurrent = await this.content.current(owner, input),
      latest = await this.ledger.get(owner, id);
    await this.content.authorize(owner, task.project);
    if (
      latest.generation !== task.generation ||
      latest.reviewRevision !== task.reviewRevision ||
      latest.dialogueDigest !== task.dialogueDigest ||
      latest.state !== task.state
    )
      throw new KnowledgeTaskError("conflict");
    return {
      task: await this.views.one(task),
      purpose: input.purpose,
      sources: context.map(({ text: _text, sections: _sections, ...metadata }) => metadata),
      dialogue,
      draft: draft ? validateKnowledgeEvidence(draft, context) : null,
      sourceCurrent,
      ...(previous && input.target.previous
        ? {
            previous: {
              state: input.target.previous.state,
              title: previousRecord(previous)?.draft.title ?? input.sources[0]!.title,
              reviewRequired: input.target.previous.reviewRequired,
            },
          }
        : {}),
    };
  }
  async answer(owner: string, id: string, value: unknown) {
    const task = await this.authorized(owner, id),
      p = knowledgeObject(value, ["answers"]);
    if (task.state !== "waiting") throw new KnowledgeTaskError("conflict");
    const dialogue = await this.files.dialogue(task.dialogueDigest),
      next = knowledgeDialogue({
        questions: dialogue.questions,
        answers: [...dialogue.answers, ...(Array.isArray(p.answers) ? p.answers : [])],
      });
    if (!Array.isArray(p.answers) || !p.answers.length || next.answers.length !== next.questions.length)
      throw new KnowledgeTaskError("invalidInput");
    const input = await this.files.input(task.inputDigest);
    if (!(await this.content.current(owner, input))) throw new KnowledgeTaskError("conflict");
    await taskKnowledgeContext(this.files, input, next);
    const digest = await this.files.putDialogue(next);
    await this.content.authorize(owner, task.project);
    const updated = await this.ledger.answer(owner, id, task.dialogueDigest, digest, this.now());
    this.execution.wake();
    return await this.views.one(updated);
  }
  async edit(owner: string, id: string, value: unknown) {
    const task = await this.authorized(owner, id),
      p = knowledgeObject(value, ["revision", "draft"]);
    if (!Number.isSafeInteger(p.revision) || task.state !== "review") throw new KnowledgeTaskError("conflict");
    const [input, dialogue] = await Promise.all([
      this.files.input(task.inputDigest),
      this.files.dialogue(task.dialogueDigest),
    ]);
    validateKnowledgeEvidence(p.draft, await taskKnowledgeContext(this.files, input, dialogue));
    const digest = await this.files.putDraft(p.draft as Parameters<KnowledgeTaskFiles["putDraft"]>[0]);
    await this.content.authorize(owner, task.project);
    return await this.views.one(await this.ledger.edit(owner, id, Number(p.revision), digest, this.now()));
  }
  async approve(owner: string, id: string, value: unknown) {
    await this.authorized(owner, id);
    const p = knowledgeObject(value, ["revision", "previousState"]);
    if (!Number.isSafeInteger(p.revision)) throw new KnowledgeTaskError("conflict");
    const task = await this.approvals.manual(
      owner,
      id,
      Number(p.revision),
      p.previousState === undefined ? undefined : knowledgeDigest(p.previousState),
    );
    await this.content.authorize(owner, task.project);
    return await this.views.one(task);
  }
  async previous(owner: string, id: string, offset = 0) {
    const task = await this.authorized(owner, id),
      input = await this.files.input(task.inputDigest),
      previous = await readTaskPrevious(this.files, input);
    if (!previous || !input.target.previous) throw new KnowledgeTaskError("notFound");
    await this.content.authorize(owner, task.project);
    return {
      previous: {
        state: input.target.previous.state,
        title: previousRecord(previous)?.draft.title ?? input.sources[0]!.title,
        reviewRequired: input.target.previous.reviewRequired,
        ...previousTextChunk(previous.markdown ?? knowledgeMarkdown(previousRecord(previous)!), offset),
      },
    };
  }
  async cancel(owner: string, id: string) {
    await this.authorized(owner, id);
    const task = await this.ledger.cancel(owner, id, this.now());
    this.execution.interrupt(owner, id);
    return await this.views.one(task);
  }
  async retry(owner: string, id: string) {
    const task = await this.authorized(owner, id);
    // Admitted delivery first recovers its existing receipt; a new write still checks sources inside its Git lease.
    if (task.state !== "committing") {
      const input = await this.files.input(task.inputDigest);
      if (!(await this.content.current(owner, input))) throw new KnowledgeTaskError("conflict");
    }
    await this.content.authorize(owner, task.project);
    const updated =
      task.state === "committing"
        ? await this.ledger.retryOutput(owner, id, this.now())
        : await this.ledger.retry(owner, id, this.now());
    this.execution.wake();
    return await this.views.one(updated);
  }
}
