import { knowledgeApi, KnowledgeApiError } from "./api.js";

/** A task can advance while immutable evidence is read; retry the read, never the task or its approval. */
export async function readKnowledgeDetail(
  id: string,
  signal: AbortSignal,
  port: Pick<typeof knowledgeApi, "detail" | "review"> = knowledgeApi,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const [detail, review] = await Promise.all([port.detail(id, signal), port.review(id, signal)]);
      signal.throwIfAborted();
      // A report from another draft revision is historical, not evidence for the displayed draft.
      const report = review.report;
      const currentReview =
        review.review?.taskRevision === detail.task.reviewRevision &&
        review.review.state !== "superseded" &&
        (!report ||
          (report.taskId === detail.task.id &&
            report.taskRevision === detail.task.reviewRevision &&
            report.id === review.review.id &&
            report.policyRevision === review.review.policyRevision));
      return { detail, review: currentReview ? review : { ...review, report: null } };
    } catch (error) {
      if (signal.aborted || !(error instanceof KnowledgeApiError) || error.code !== "conflict" || attempt === 2)
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
