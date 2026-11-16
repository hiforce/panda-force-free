import { request } from "../../http-client.js";
import { PluginApiError } from "../api.js";
import type {
  TemplateDefinition,
  TemplateDraft,
  TemplateLibrarySnapshot,
  TemplateDraftPreview,
  TemplateRelease,
} from "../../../shared/plugins/library.js";
import type { PluginInstallReview } from "../../../shared/plugins/registry.js";

async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request("/api/template-library" + path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new PluginApiError(response.status, value);
  return value as T;
}
export const templateLibraryApi = {
  list: () => json<TemplateLibrarySnapshot>(""),
  detail: (id: string) => json<{ draft: TemplateDraft }>("/draft?" + new URLSearchParams({ id })),
  save: (definition: TemplateDefinition, current: TemplateDraft | null) =>
    current
      ? json<{ draft: TemplateDraft }>("/draft?" + new URLSearchParams({ id: current.id }), "PUT", {
          definition,
          revision: current.revision,
        })
      : json<{ draft: TemplateDraft }>("", "POST", definition),
  preview: (id: string, fixtureId: string) =>
    json<TemplateDraftPreview>("/preview", "POST", {
      id,
      fixtureId,
    }),
  validate: (draft: TemplateDraft) =>
    json<{ draft: TemplateDraft }>("/validate", "POST", { id: draft.id, revision: draft.revision }),
  fork: (draft: TemplateDraft, version: string) =>
    json<{ draft: TemplateDraft }>("/fork", "POST", { id: draft.id, version }),
  forkRelease: (id: string, fromVersion: string, version: string) =>
    json<{ draft: TemplateDraft }>("/fork", "POST", { id, fromVersion, version }),
  baseline: (draft: TemplateDraft, fixtureId: string, digest: string) =>
    json<{ draft: TemplateDraft }>("/baseline", "POST", { id: draft.id, revision: draft.revision, fixtureId, digest }),
  release: (id: string, version: string) =>
    json<{ release: TemplateRelease }>("/release?" + new URLSearchParams({ id, version })),
  remove: (draft: TemplateDraft) =>
    json<{ ok: true }>("/draft?" + new URLSearchParams({ id: draft.id }), "DELETE", { revision: draft.revision }),
  publish: (draft: TemplateDraft, review: PluginInstallReview) =>
    json<{ release: TemplateRelease }>("/publish", "POST", {
      id: draft.id,
      revision: draft.revision,
      digest: draft.digest,
      approval: { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
    }),
};
