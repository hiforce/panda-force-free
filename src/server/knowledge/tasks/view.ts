import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeTask } from "../../../shared/knowledge/tasks.js";

import type { KnowledgeReviewStore, KnowledgeReviewLease } from "../review/contracts.js";
import { knowledgeAutomaticReviewView } from "../review/service.js";
import { type KnowledgeTaskRow } from "./contracts.js";

/** Public task views intentionally omit leases, execution sessions and private file digests. */
export function knowledgeTaskView(task: KnowledgeTaskRow): KnowledgeTask {
  const {
    id,
    title,
    project,
    state,
    generation,
    attempts,
    rounds,
    reviewRevision,
    failure,
    result,
    createdAt,
    updatedAt,
  } = task;
  return {
    ...(task.origin ? { origin: task.origin } : {}),
    manualReviewRequired: task.autoEligible === 0,
    id,
    title,
    project,
    state,
    generation,
    attempts,
    rounds,
    reviewRevision,
    failure,
    result,
    createdAt,
    updatedAt,
  };
}
export class KnowledgeTaskViews {
  constructor(private readonly reviews?: Pick<MetadataStore<KnowledgeReviewStore>, "latest" | "latestFor">) {}
  async one(task: KnowledgeTaskRow): Promise<KnowledgeTask> {
    return this.reviewedView(task, this.reviews ? await this.reviews.latest(task.owner, task.id) : null);
  }
  private reviewedView(task: KnowledgeTaskRow, review: KnowledgeReviewLease | null): KnowledgeTask {
    return {
      ...knowledgeTaskView(task),
      ...(this.reviews
        ? {
            automaticReview: knowledgeAutomaticReviewView(review, task.reviewRevision),
          }
        : {}),
    };
  }
  async page(owner: string, tasks: KnowledgeTaskRow[]) {
    const reviews = new Map(
      (this.reviews
        ? await this.reviews.latestFor(
            owner,
            tasks.map((task) => task.id),
          )
        : []
      ).map((review) => [review.taskId, review]),
    );
    return tasks.map((task) => this.reviewedView(task, reviews.get(task.id) ?? null));
  }
}
