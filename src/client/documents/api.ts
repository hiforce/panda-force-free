import { request } from "../http-client.js";
import { personalContentPath } from "../../shared/creative/scope.js";
import type {
  DocumentDetail,
  DocumentPage,
  DocumentRevision,
  DocumentSpace,
  DocumentSpaceInput,
  ImportResult,
  SourceInspection,
} from "../../shared/documents/contracts.js";

export class DocumentApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Document request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(personalContentPath(path, body), {
    method,
    signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new DocumentApiError(response.status, payload);
  return payload as T;
}
export { json as documentJson };
export const documentApi = {
  sourceProfile: (id: string) =>
    json<{ space: DocumentSpace; profile: import("../../shared/sites/profile.js").SiteSourceProfile | null }>(
      "/api/document-spaces/source-profile?" + new URLSearchParams({ id }),
    ),
  sourceOptions: (id: string) =>
    json<import("../../shared/sites/profile.js").SourceConfigurationOptions>(
      "/api/document-spaces/source-profile/options?" + new URLSearchParams({ id }),
    ),
  inspectSourceProfile: (id: string, locale: string, files: string[], webp: boolean) =>
    json<import("../../shared/sites/profile.js").SourceConfigurationProposal>(
      "/api/document-spaces/source-profile/inspect",
      "POST",
      { id, locale, files, webp },
    ),
  saveSourceProfile: (id: string, version: number, profile: unknown) =>
    json<{ space: DocumentSpace }>("/api/document-spaces/source-profile?" + new URLSearchParams({ id }), "PUT", {
      version,
      profile,
    }),
  themes: (engine = "markdown") =>
    json<{ themes: import("../../shared/presentation/themes.js").SiteThemeDescriptor[] }>(
      "/api/document-themes?" + new URLSearchParams({ engine }),
    ),
  setTheme: (id: string, version: number, theme: string) =>
    json<{ space: DocumentSpace }>("/api/document-spaces/theme", "PUT", { id, version, theme }),
  spaces: (project: string) =>
    json<{ spaces: DocumentSpace[] }>("/api/document-spaces?" + new URLSearchParams({ project })),
  createSpace: (input: DocumentSpaceInput) => json<{ space: DocumentSpace }>("/api/document-spaces", "POST", input),
  inspect: (path: string) => json<SourceInspection>("/api/document-spaces/inspect", "POST", { path }),
  importImages: (id: string, revision: number) =>
    json<import("../../shared/documents/contracts.js").DocumentAssetImportResult>(
      "/api/documents/import-assets",
      "POST",
      { id, revision },
    ),
  scan: (spaceId: string) => json<ImportResult>("/api/document-spaces/import", "POST", { spaceId }),
  list: (space: string, search = "", offset = 0) =>
    json<DocumentPage>("/api/documents?" + new URLSearchParams({ space, search, offset: String(offset) })),
  detail: (id: string) => json<DocumentDetail>("/api/documents/detail?" + new URLSearchParams({ id })),
  create: (input: { spaceId: string; path: string; title: string; locale: string; content: string }) =>
    json<DocumentDetail>("/api/documents", "POST", input),
  save: (
    id: string,
    input: {
      revision: number;
      title: string;
      locale: string;
      content: string;
      body?: import("../../shared/documents/rich-body.js").RichDocumentBody;
      restoreRevisionId?: string;
    },
  ) => json<DocumentDetail>("/api/documents/detail?" + new URLSearchParams({ id }), "PUT", input),
  history: (id: string) =>
    json<{ revisions: Omit<DocumentRevision, "content">[] }>("/api/documents/revisions?" + new URLSearchParams({ id })),
  revision: (id: string, revision: string) =>
    json<{ revision: DocumentRevision }>("/api/documents/revisions?" + new URLSearchParams({ id, revision })),
};

export const documentResourcesApi = {
  assets: (document: string) =>
    json<{ assets: import("../../shared/documents/contracts.js").DocumentAsset[] }>(
      "/api/document-assets?" + new URLSearchParams({ document }),
    ),
  async upload(document: string, file: File) {
    const response = await request("/api/document-assets?" + new URLSearchParams({ document, name: file.name }), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) throw new DocumentApiError(response.status, payload);
    return payload as { asset: import("../../shared/documents/contracts.js").DocumentAsset };
  },
  languages: (id: string) =>
    json<{ documents: import("../../shared/documents/contracts.js").DocumentRecord[] }>(
      "/api/document-languages?" + new URLSearchParams({ id }),
    ),
  link: (id: string, otherId: string) =>
    json<{ documents: import("../../shared/documents/contracts.js").DocumentRecord[] }>(
      "/api/document-languages?" + new URLSearchParams({ id }),
      "POST",
      { otherId },
    ),
  unlink: (id: string) =>
    json<{ documents: import("../../shared/documents/contracts.js").DocumentRecord[] }>(
      "/api/document-languages?" + new URLSearchParams({ id }),
      "DELETE",
    ),
};
