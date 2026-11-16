import { request } from "../http-client.js";
import type { EditorialDetail, EditorialReceipt, EditorialHistoryPage } from "../../shared/editorial/contracts.js";
import type { EditorialJob, EditorialProcessingProfile } from "../../shared/editorial/jobs.js";

export class EditorialApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Editorial request failed");
  }
}
async function json<T>(path: string, method = "GET", input?: unknown): Promise<T> {
  const response = await request(path, {
    method,
    ...(input ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new EditorialApiError(response.status, payload);
  return payload as T;
}
export function editorialApiFor(projectId?: string) {
  const query = (fields: Record<string, string>) =>
    new URLSearchParams({ ...fields, ...(projectId === undefined ? {} : { project: projectId }) });
  return {
    history: (document: string, before?: string) =>
      json<EditorialHistoryPage>(
        "/api/document-editorial/history?" + query({ document, ...(before ? { before } : {}) }),
      ),
    detail: (id: string) => json<EditorialDetail>("/api/document-editorial/detail?" + query({ id })),
    prepare: (id: string, documentId: string, revisionId: string) =>
      json<EditorialDetail>("/api/document-editorial", "POST", {
        id,
        documentId,
        revisionId,
        mode: "spacing",
        ...(projectId === undefined ? {} : { projectId }),
      }),
    accept: (id: string, digest: string, selected: string[]) =>
      json<{ receipt: EditorialReceipt }>("/api/document-editorial/accept", "POST", { id, digest, selected }),
    processors: () =>
      json<{ profiles: EditorialProcessingProfile[]; configurationInvalid: boolean }>(
        "/api/document-editorial/processors",
      ),
    jobs: (document: string) => json<{ jobs: EditorialJob[] }>("/api/document-editorial/jobs?" + query({ document })),
    job: (id: string) => json<{ job: EditorialJob }>("/api/document-editorial/jobs/detail?" + query({ id })),
    submitJob: (input: {
      id: string;
      documentId: string;
      revisionId: string;
      profileId: string;
      mode: "proofread" | "rewrite";
    }) =>
      json<{ job: EditorialJob }>("/api/document-editorial/jobs", "POST", {
        ...input,
        ...(projectId === undefined ? {} : { projectId }),
      }),
    cancelJob: (id: string) =>
      json<{ job: EditorialJob }>("/api/document-editorial/jobs/action", "POST", { id, action: "cancel" }),
    retryJob: (id: string, retryId: string) =>
      json<{ job: EditorialJob }>("/api/document-editorial/jobs/action", "POST", { id, action: "retry", retryId }),
  };
}
export const editorialApi = editorialApiFor();
export type EditorialApi = ReturnType<typeof editorialApiFor>;
