import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";
import type { TemplateCatalogPage } from "../../shared/templates/catalog.js";
import type { SkillInstallReview, SkillPackDetail } from "../../shared/skills/registry.js";

export async function templateJson<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(path, {
    method,
    signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new PluginApiError(response.status, value);
  return value as T;
}
export const managedTemplatesApi = {
  item: (key: string, signal?: AbortSignal) =>
    templateJson<import("../../shared/templates/catalog.js").ManagedTemplate>(
      "/api/skill-workspace/skill?" + new URLSearchParams({ key }),
      "GET",
      undefined,
      signal,
    ),
  list: (query: URLSearchParams, signal?: AbortSignal) =>
    templateJson<TemplateCatalogPage>("/api/template-catalog?" + query, "GET", undefined, signal),
};
export const skillManagerApi = {
  detail: (id: string, version: string) =>
    templateJson<SkillPackDetail>("/api/skill-packs/detail?" + new URLSearchParams({ id, version })),
  template: (id: string, version: string, exportId: string) =>
    templateJson<{ kind: "structure" | "instructions"; content: string }>(
      "/api/skill-packs/template?" + new URLSearchParams({ id, version, exportId }),
    ),
  export: (id: string, version: string) =>
    templateJson<unknown>("/api/skill-packs/export?" + new URLSearchParams({ id, version })),
  review: (content: string, name: string, selected?: string[]) =>
    templateJson<SkillInstallReview>("/api/skill-packs/review", "POST", { content, name, selected }),
  install: (content: string, name: string, review: SkillInstallReview, operationId: string) =>
    templateJson<SkillPackDetail>("/api/skill-packs/install", "POST", {
      content,
      name,
      approval: {
        id: operationId,
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
        capabilities: review.capabilities,
      },
    }),
  setExports: (detail: SkillPackDetail, id: string, enabled: boolean) =>
    templateJson<SkillPackDetail>("/api/skill-packs/exports", "PUT", {
      operationId: crypto.randomUUID(),
      id: detail.package!.id,
      version: detail.package!.version,
      expectedRevision: detail.revision,
      exports: detail.package!.exports.map((entry) => ({
        id: entry.id,
        enabled: entry.id === id ? enabled : entry.enabled,
      })),
    }),
  activate: (detail: SkillPackDetail) =>
    templateJson<SkillPackDetail>("/api/skill-packs/activate", "POST", {
      operationId: crypto.randomUUID(),
      id: detail.package!.id,
      version: detail.package!.version,
      expectedRevision: detail.revision,
    }),
};
export function downloadTemplate(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
