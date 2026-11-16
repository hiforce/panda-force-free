import { expect, test } from "bun:test";
import { readKnowledgeDetail } from "../../src/client/knowledge/read-detail.js";
import { KnowledgeApiError, type KnowledgeReviewDetail, knowledgeApi } from "../../src/client/knowledge/api.js";
import type { KnowledgeTaskDetail } from "../../src/shared/knowledge/tasks.js";

const detail = { task: { id: "task", reviewRevision: 3 } } as KnowledgeTaskDetail;
const review = {
  policy: { automatic: true, revision: 2 },
  review: { id: "report", taskRevision: 3, policyRevision: 2, state: "passed" },
  report: { id: "report", taskId: "task", taskRevision: 3, policyRevision: 2 },
} as KnowledgeReviewDetail;

test("a transient task transition recovers through reads; persistent conflicts stop without replaying a mutation", async () => {
  let reads = 0;
  const port: Pick<typeof knowledgeApi, "detail" | "review"> = {
    detail: async () => {
      if (++reads === 1) throw new KnowledgeApiError("conflict");
      return detail;
    },
    review: async () => review,
  };
  expect((await readKnowledgeDetail("task", new AbortController().signal, port)).detail).toBe(detail);
  expect(reads).toBe(2);
  reads = 0;
  port.detail = async () => {
    reads++;
    throw new KnowledgeApiError("conflict");
  };
  await expect(readKnowledgeDetail("task", new AbortController().signal, port)).rejects.toThrow("conflict");
  expect(reads).toBe(3);
});

test("review presentation requires the same task, draft, policy and report identity", async () => {
  const signal = new AbortController().signal;
  for (const mismatch of [{ taskId: "other" }, { taskRevision: 2 }, { policyRevision: 1 }, { id: "old-report" }]) {
    const result = await readKnowledgeDetail("task", signal, {
      detail: async () => detail,
      review: async () => ({ ...review, report: { ...review.report!, ...mismatch } }),
    });
    expect(result.review.report).toBeNull();
  }
  expect(
    (await readKnowledgeDetail("task", signal, { detail: async () => detail, review: async () => review })).review
      .report,
  ).toBe(review.report);
});
