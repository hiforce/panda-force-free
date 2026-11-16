import { request } from "../http-client.js";
import type { WorkflowRecord, WorkflowRecoveryEvidence } from "../../shared/delivery/workflow.js";
export class SocialApiError extends Error {
  constructor(readonly payload: unknown) {
    super("Social publication request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request("/api/social-publications" + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new SocialApiError(value);
  return value as T;
}
const recoveryBinding = (record: WorkflowRecord) => ({
  id: record.plan.id,
  kind: record.plan.kind,
  fingerprint: record.plan.fingerprint,
});
export const socialApi = {
  detail: (kind: string, id: string) =>
    json<{ publication: WorkflowRecord }>("/detail?" + new URLSearchParams({ kind, id })),
  successor: (record: WorkflowRecord, successorId: string) =>
    json<{ publication: WorkflowRecord }>("/successor", "POST", {
      ...recoveryBinding(record),
      stateToken: record.continuationToken,
      successorId,
      acceptContinuation: true,
    }),
  inspect: (record: WorkflowRecord, stepId: number, remoteId: string) =>
    json<{ evidence: WorkflowRecoveryEvidence }>("/recovery/inspect", "POST", {
      ...recoveryBinding(record),
      stepId,
      remoteId,
      acceptLookupCosts: true,
    }),
  adopt: (record: WorkflowRecord, evidenceId: string) =>
    json<{ publication: WorkflowRecord }>("/recovery/adopt", "POST", {
      ...recoveryBinding(record),
      evidenceId,
      acceptExistingResult: true,
    }),
  context: (variant: string) =>
    json<{ projectId: string; spaceId: string; sourceProjectId?: string }>(
      "/context?" + new URLSearchParams({ variant }),
    ),
  list: (space: string, project?: string) =>
    json<{ publications: WorkflowRecord[] }>(
      "?" + new URLSearchParams({ space, ...(project === undefined ? {} : { project }) }),
    ),
  prepare: (input: { id: string; variantId: string; connectionId: string }) =>
    json<{ publication: WorkflowRecord }>("", "POST", input),
  article: (input: { id: string; draftId: string }) =>
    json<{ publication: WorkflowRecord }>("/article-publish", "POST", input),
  submit: (record: WorkflowRecord, resume: boolean) =>
    json<{ publication: WorkflowRecord }>("/submit", "POST", {
      id: record.plan.id,
      kind: record.plan.kind,
      fingerprint: record.plan.fingerprint,
      acceptPlatformCosts: true,
      acceptPlatformEligibility: true,
      resume,
    }),
  cancel: (record: WorkflowRecord) =>
    json<{ publication: WorkflowRecord }>("/cancel", "POST", { id: record.plan.id, kind: record.plan.kind }),
};
