import { request } from "../http-client.js";
import type { KnowledgeTask, KnowledgeTaskDetail, KnowledgeTaskPage } from "../../shared/knowledge/tasks.js";
import type {
  KnowledgeAutomaticReview,
  KnowledgeReviewPolicy,
  KnowledgeReviewReport,
} from "../../shared/knowledge/review.js";

export class KnowledgeApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export async function knowledgeRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request("/api/knowledge" + path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new KnowledgeApiError(typeof value?.code === "string" ? value.code : "unavailable");
  return value as T;
}
export interface KnowledgeReviewDetail {
  policy: KnowledgeReviewPolicy;
  review: KnowledgeAutomaticReview | null;
  report: KnowledgeReviewReport | null;
}
export const knowledgeApi = {
  options: (signal: AbortSignal) => knowledgeRequest<{ available: boolean }>("/options", "GET", undefined, signal),
  list: (project: string, signal: AbortSignal, cursor?: string) =>
    knowledgeRequest<KnowledgeTaskPage>(
      "/tasks?" + new URLSearchParams({ project, ...(cursor ? { cursor } : {}) }),
      "GET",
      undefined,
      signal,
    ),
  status: (id: string, signal: AbortSignal) =>
    knowledgeRequest<{ task: KnowledgeTask }>("/tasks/status?" + new URLSearchParams({ id }), "GET", undefined, signal),
  detail: (id: string, signal: AbortSignal) =>
    knowledgeRequest<KnowledgeTaskDetail>("/tasks/detail?" + new URLSearchParams({ id }), "GET", undefined, signal),
  policy: (project: string, signal: AbortSignal) =>
    knowledgeRequest<{ policy: KnowledgeReviewPolicy }>(
      "/review-policy?" + new URLSearchParams({ project }),
      "GET",
      undefined,
      signal,
    ),
  review: (id: string, signal: AbortSignal) =>
    knowledgeRequest<KnowledgeReviewDetail>("/tasks/review?" + new URLSearchParams({ id }), "GET", undefined, signal),
};
