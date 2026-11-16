import { request } from "../http-client.js";
import type { VariantDetail, VariantSummary } from "../../shared/publishing/variants.js";
import type { ProofreadingSuggestion, PublicationFormat } from "../../shared/publishing/content.js";

export class PublishingApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Publishing request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new PublishingApiError(response.status, payload);
  return payload as T;
}
export function publishingApiFor(projectId?: string) {
  const query = (value: Record<string, string>) =>
    new URLSearchParams({ ...value, ...(projectId === undefined ? {} : { project: projectId }) });
  const scope = projectId === undefined ? {} : { projectId };
  return {
    imageUrl:
      projectId === undefined
        ? undefined
        : (id: string) => "/api/project-documents/assets/content?" + new URLSearchParams({ project: projectId, id }),
    templates: () =>
      json<{ templates: import("../../shared/presentation/templates.js").ChannelTemplateDescriptor[] }>(
        "/api/publication-templates",
      ),
    list: (document: string) =>
      json<{ variants: VariantSummary[] }>("/api/publication-variants?" + query({ document })),
    detail: (id: string) => json<VariantDetail>("/api/publication-variants/detail?" + query({ id })),
    prepare: (
      documentId: string,
      revisionId: string,
      format: PublicationFormat,
      templateId: string,
      templateVersion?: string,
    ) =>
      json<VariantDetail>("/api/publication-variants", "POST", {
        ...scope,
        documentId,
        revisionId,
        format,
        templateId,
        ...(templateVersion ? { templateVersion } : {}),
        mode: "format",
      }),
    review: (id: string, digest: string, acceptedIssues: string[]) =>
      json<VariantDetail>("/api/publication-variants/review", "POST", { id, digest, acceptedIssues }),
    proofread: (document: string, revision: string) =>
      json<{ suggestions: ProofreadingSuggestion[] }>("/api/publication-proofread?" + query({ document, revision })),
    apply: (documentId: string, revisionId: string, selected: string[]) =>
      json<{ sourceRevision: string; content: string }>("/api/publication-proofread", "POST", {
        ...scope,
        documentId,
        revisionId,
        selected,
      }),
    exportUrl: (id: string, kind: "html" | "text" | "bundle") =>
      "/api/publication-variants/export?" + query({ id, kind }),
  };
}
export const publishingApi = publishingApiFor();
