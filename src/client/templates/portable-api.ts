import type {
  InstalledPortableTemplate,
  PortableTemplateReview,
  PortableInstallResult,
} from "../../shared/templates/portable/registry.js";
import type { PortableTemplateManifest } from "../../shared/templates/portable/contracts.js";
import type { PortableTemplateModel } from "../../shared/templates/types/contracts.js";
import { templateJson } from "./api.js";

export interface PortableTemplateDetail {
  revision: number;
  template: InstalledPortableTemplate;
}
export const portableTemplatesApi = {
  detail: (query: URLSearchParams) => templateJson<PortableTemplateDetail>("/api/templates/detail?" + query),
  preview: (query: URLSearchParams) =>
    templateJson<{ manifest: PortableTemplateManifest; model: PortableTemplateModel }>(
      "/api/templates/preview?" + query,
    ),
  export: (query: URLSearchParams) => templateJson<unknown>("/api/templates/export?" + query),
  review: (content: string, name: string, selected?: string[]) =>
    templateJson<PortableTemplateReview>("/api/templates/review", "POST", { content, name, selected }),
  install: (content: string, name: string, review: PortableTemplateReview, operationId: string) =>
    templateJson<PortableInstallResult>("/api/templates/install", "POST", {
      content,
      name,
      approval: {
        operationId,
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
    }),
  state: (detail: PortableTemplateDetail, action: "enable" | "disable" | "activate") =>
    templateJson<PortableTemplateDetail>("/api/templates/state", "PUT", {
      id: detail.template.id,
      version: detail.template.version,
      digest: detail.template.digest,
      expectedRevision: detail.revision,
      action,
    }),
};
