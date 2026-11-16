import { request } from "../http-client.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import type { PluginAuditEvent, PluginInstallReview, PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import type { PluginExportRef } from "../../shared/plugins/exports.js";

export class PluginApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Package request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request("/api/document-packages" + path, {
    method,
    signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new PluginApiError(response.status, payload);
  return payload as T;
}
export const pluginApi = {
  export: (id: string, version: string) => json<PluginPackage>("/export?" + new URLSearchParams({ id, version })),
  fromSource: (spaceId: string, theme: string, manifest: import("../../shared/plugins/contracts.js").PluginManifest) =>
    json<import("../../shared/plugins/contracts.js").VerifiedPluginPackage>("/from-source", "POST", {
      spaceId,
      theme,
      manifest,
    }),
  list: (signal?: AbortSignal) => json<PluginRegistrySnapshot>("", "GET", undefined, signal),
  audit: () => json<{ events: PluginAuditEvent[] }>("/audit"),
  review: (value: unknown) => json<PluginInstallReview>("/review", "POST", value),
  reviewSelection: (value: unknown, selected: readonly PluginExportRef[]) =>
    json<PluginInstallReview>("/review-selection", "POST", { package: value, selected }),
  install: (value: PluginPackage, review: PluginInstallReview) =>
    json<PluginRegistrySnapshot>("/install", "POST", {
      package: value,
      approval: {
        digest: review.digest,
        expectedRevision: review.revision,
        permissions: review.permissions,
        selected: review.selected,
        reviewHash: review.reviewHash,
      },
    }),
  state: (id: string, version: string, enabled: boolean, expectedRevision: number) =>
    json<PluginRegistrySnapshot>("/state", "PUT", { id, version, enabled, expectedRevision }),
  activate: (id: string, version: string, expectedRevision: number) =>
    json<PluginRegistrySnapshot>("/activate", "POST", { id, version, expectedRevision }),
  exportState: (id: string, version: string, entry: PluginExportRef, enabled: boolean, expectedRevision: number) =>
    json<PluginRegistrySnapshot>("/exports/state", "PUT", { id, version, export: entry, enabled, expectedRevision }),
  activateExport: (id: string, version: string, entry: PluginExportRef, expectedRevision: number) =>
    json<PluginRegistrySnapshot>("/exports/activate", "POST", { id, version, export: entry, expectedRevision }),
};
