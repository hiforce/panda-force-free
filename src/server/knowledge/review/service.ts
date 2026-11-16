import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeContent, KnowledgeTaskFiles, KnowledgeTaskStore } from "../tasks/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { knowledgeId, knowledgeObject } from "../../../shared/knowledge/task-validation.js";
import type { KnowledgeAutomaticReview } from "../../../shared/knowledge/review.js";
import type { KnowledgeReviewStore } from "./contracts.js";
export function knowledgeAutomaticReviewView(
  value: ReturnType<KnowledgeReviewStore["latest"]>,
  revision: number,
): KnowledgeAutomaticReview | null {
  if (!value) return null;
  const { id, taskRevision, policyRevision, state, createdAt, finishedAt } = value;
  return {
    id,
    taskRevision,
    policyRevision,
    state: taskRevision === revision ? state : "superseded",
    createdAt,
    finishedAt,
  };
}
/** Turning automatic review off never removes human review or the underlying source/version checks. */
export class KnowledgeReviewSettings {
  constructor(
    private readonly reviews: Pick<MetadataStore<KnowledgeReviewStore>, "policy" | "configure" | "latest">,
    private readonly tasks: Pick<MetadataStore<KnowledgeTaskStore>, "get">,
    private readonly files: Pick<KnowledgeTaskFiles, "review">,
    private readonly content: Pick<KnowledgeContent, "authorize">,
    private readonly execution: {
      reviewChanged(owner: string, project: string): void;
    },
    private readonly now: () => number = Date.now,
  ) {}
  async policy(owner: string, project: string) {
    knowledgeId(project);
    await this.content.authorize(owner, project);
    return await this.reviews.policy(owner, project);
  }
  async configure(owner: string, project: string, input: unknown) {
    knowledgeId(project);
    const p = knowledgeObject(input, ["automatic", "revision"]);
    if (typeof p.automatic !== "boolean" || !Number.isSafeInteger(p.revision) || Number(p.revision) < 0)
      throw new KnowledgeTaskError("invalidInput");
    await this.content.authorize(owner, project);
    const policy = await this.reviews.configure(owner, project, p.automatic, Number(p.revision), this.now());
    this.execution.reviewChanged(owner, project);
    return policy;
  }
  async detail(owner: string, id: string) {
    const task = await this.tasks.get(owner, knowledgeId(id));
    await this.content.authorize(owner, task.project);
    const review = await this.reviews.latest(owner, id),
      report = review?.reportDigest ? await this.files.review(review.reportDigest) : null;
    await this.content.authorize(owner, task.project);
    return {
      policy: await this.reviews.policy(owner, task.project),
      review: knowledgeAutomaticReviewView(review, task.reviewRevision),
      report,
    };
  }
}
