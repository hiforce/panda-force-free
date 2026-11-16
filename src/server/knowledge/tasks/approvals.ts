import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeApproval, KnowledgeReviewReport } from "../../../shared/knowledge/review.js";
import { knowledgeReviewVerdict } from "../../../shared/knowledge/review.js";
import type { KnowledgeRecord } from "../../../shared/knowledge/tasks.js";
import { validateKnowledgeEvidence } from "../evidence.js";
import { taskKnowledgeContext } from "./evidence-context.js";
import { knowledgeRecordVersion } from "./record.js";
import {
  KnowledgeTaskError,
  type KnowledgeContent,
  type KnowledgeTaskFiles,
  type KnowledgeTaskStore,
} from "./contracts.js";
import type { KnowledgeReviewLease, KnowledgeReviewStore } from "../review/contracts.js";
/** Human and automatic approval share evidence checks and the same idempotent file/Git delivery. */
export class KnowledgeApprovals {
  constructor(
    private readonly tasks: Pick<MetadataStore<KnowledgeTaskStore>, "get" | "admit">,
    private readonly files: KnowledgeTaskFiles,
    private readonly content: KnowledgeContent,
    private readonly output: {
      reconcile(owner: string, id: string): Promise<void>;
    },
    private readonly reviews?: Pick<MetadataStore<KnowledgeReviewStore>, "admit">,
    private readonly now: () => number = Date.now,
  ) {}
  async manual(owner: string, id: string, revision: number, previousState?: string) {
    const task = await this.tasks.get(owner, id);
    await this.content.authorize(owner, task.project);
    if (revision !== task.reviewRevision) throw new KnowledgeTaskError("conflict");
    if (task.state === "review") {
      const input = await this.files.input(task.inputDigest),
        previous = input.target.previous;
      if (
        (previous?.reviewRequired && previousState !== previous.state) ||
        (previousState !== undefined && previousState !== previous?.state)
      )
        throw new KnowledgeTaskError("conflict");
      const digest = await this.prepare(owner, id, { mode: "manual" }, this.now());
      await this.content.authorize(owner, task.project);
      await this.tasks.admit(owner, id, revision, digest, this.now());
    } else if (!["committing", "completed"].includes(task.state)) throw new KnowledgeTaskError("conflict");
    await this.output.reconcile(owner, id);
    return await this.tasks.get(owner, id);
  }
  async automatic(review: KnowledgeReviewLease) {
    if (!this.reviews || !review.reportDigest || review.state !== "passed") throw new KnowledgeTaskError("conflict");
    const report = await this.files.review(review.reportDigest),
      task = await this.tasks.get(review.owner, review.taskId);
    if (
      report.verdict !== "approve" ||
      report.id !== review.id ||
      report.taskId !== task.id ||
      report.taskRevision !== task.reviewRevision ||
      report.policyRevision !== review.policyRevision ||
      report.inputDigest !== task.inputDigest ||
      report.dialogueDigest !== task.dialogueDigest ||
      report.draftDigest !== task.draftDigest
    )
      throw new KnowledgeTaskError("conflict");
    const [input, draft] = await Promise.all([this.files.input(task.inputDigest), this.files.draft(task.draftDigest!)]);
    if (report.engineId !== input.profile.engineId || report.model !== input.profile.model)
      throw new KnowledgeTaskError("conflict");
    knowledgeReviewVerdict(
      {
        schema: report.schema,
        verdict: report.verdict,
        summary: report.summary,
        checks: report.checks,
        claims: report.claims,
        issues: report.issues,
      },
      draft,
    );
    const digest = await this.prepare(
      review.owner,
      task.id,
      {
        mode: "automatic",
        reviewId: review.id,
        policyRevision: review.policyRevision,
        reportDigest: review.reportDigest,
        engineId: report.engineId,
        model: report.model,
      },
      report.reviewedAt,
      report,
    );
    await this.content.authorize(review.owner, task.project);
    await this.reviews.admit(review, review.reportDigest, digest, this.now());
    await this.output.reconcile(review.owner, task.id);
  }
  private async prepare(
    owner: string,
    id: string,
    approval: KnowledgeApproval,
    approvedAt: number,
    review?: KnowledgeReviewReport,
  ) {
    const task = await this.tasks.get(owner, id);
    if (task.state !== "review" || !task.draftDigest) throw new KnowledgeTaskError("conflict");
    const [input, dialogue, draft] = await Promise.all([
      this.files.input(task.inputDigest),
      this.files.dialogue(task.dialogueDigest),
      this.files.draft(task.draftDigest),
    ]);
    if (!(await this.content.current(owner, input))) throw new KnowledgeTaskError("conflict");
    if (approval.mode === "automatic" && input.target.previous?.reviewRequired)
      throw new KnowledgeTaskError("conflict");
    const context = await taskKnowledgeContext(this.files, input, dialogue),
      record: KnowledgeRecord = {
        schema: 1,
        id: input.target.id,
        version: "",
        previousVersion: input.target.expectedVersion,
        taskId: id,
        sourceCommit: input.sourceCommit,
        sources: context.map(({ text: _text, sections: _sections, ...metadata }) => metadata),
        draft: validateKnowledgeEvidence(draft, context),
        approvedAt,
        approval,
        ...(review ? { review } : {}),
      };
    record.version = knowledgeRecordVersion(record);
    return this.files.putOutput(record);
  }
}
