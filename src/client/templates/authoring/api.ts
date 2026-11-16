import type {
  TemplateDraftDetail,
  TemplateDraftRecord,
  TemplateDraftResult,
} from "../../../shared/templates/authoring/contracts.js";
import type { TemplateNativeReference } from "../../../shared/templates/catalog.js";
import type { PortableInstallResult, PortableTemplateReview } from "../../../shared/templates/portable/registry.js";
import { templateJson } from "../api.js";
import type { TemplateSaveCommand } from "./session.js";
import type { TemplateImage } from "../../../shared/templates/authoring/images.js";
import { request } from "../../http-client.js";
import { PluginApiError } from "../../plugins/api.js";

export const templateAuthoringApi = {
  async image(draft: string, file: File): Promise<TemplateImage> {
    const response = await request("/api/template-drafts/images?" + new URLSearchParams({ draft }), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    const value = await response.json();
    if (!response.ok) throw new PluginApiError(response.status, value);
    return value.image;
  },
  list: () => templateJson<{ drafts: TemplateDraftRecord[] }>("/api/template-drafts"),
  detail: (id: string) =>
    templateJson<TemplateDraftDetail>("/api/template-drafts/detail?" + new URLSearchParams({ id })),
  create: (command: unknown) => templateJson<TemplateDraftResult>("/api/template-drafts", "POST", command),
  save: (command: TemplateSaveCommand) => templateJson<TemplateDraftResult>("/api/template-drafts", "PUT", command),
  fork: (id: string, operationId: string, reference: TemplateNativeReference) =>
    templateJson<TemplateDraftResult>("/api/template-drafts/fork", "POST", {
      id,
      operationId,
      expectedRevision: 0,
      reference,
    }),
  remove: (draft: TemplateDraftRecord, operationId: string) =>
    templateJson<TemplateDraftResult>("/api/template-drafts", "DELETE", {
      operationId,
      id: draft.id,
      expectedRevision: draft.revision,
    }),
  review: (draft: TemplateDraftRecord) =>
    templateJson<PortableTemplateReview>("/api/template-drafts/review", "POST", {
      id: draft.id,
      revision: draft.revision,
      digest: draft.digest,
    }),
  publish: (draft: TemplateDraftRecord, review: PortableTemplateReview, operationId: string) =>
    templateJson<PortableInstallResult>("/api/template-drafts/publish", "POST", {
      id: draft.id,
      revision: draft.revision,
      digest: draft.digest,
      approval: {
        operationId,
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
    }),
};
