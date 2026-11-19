import type { CreativeAssetPurgeResult } from "../../shared/creative/assets.js";
import { creativeImportKind } from "../../shared/creative/file-types.js";
import type {
  CreativeAsset,
  CreativeAssetDetail,
  CreativeAssetPage,
  CreativeWebBundleInspection,
} from "../../shared/creative/assets.js";
import { documentJson, DocumentApiError } from "../documents/api.js";
import { request } from "../http-client.js";

export const creativeAssetsApi = {
  list: (project: string, cursor?: string, signal?: AbortSignal, state = "saved") =>
    documentJson<CreativeAssetPage>(
      "/api/creative-assets?" + new URLSearchParams({ project, state, ...(cursor ? { cursor } : {}) }),
      "GET",
      undefined,
      signal,
    ),
  capabilities: (project: string, signal?: AbortSignal) =>
    documentJson<{ contribute: boolean; originals?: boolean }>(
      "/api/creative-assets/capabilities?" + new URLSearchParams({ project }),
      "GET",
      undefined,
      signal,
    ),
  detail: (project: string, id: string, signal?: AbortSignal) =>
    documentJson<CreativeAssetDetail>(
      "/api/creative-assets/item?" + new URLSearchParams({ project, id }),
      "GET",
      undefined,
      signal,
    ),
  content: (project: string, id: string, version: string) =>
    "/api/creative-assets/content?" + new URLSearchParams({ project, id, version }),
  view: (project: string, id: string, version: string) =>
    "/api/creative-assets/view?" + new URLSearchParams({ project, id, version }),
  link: (asset: CreativeAsset, signal?: AbortSignal) =>
    documentJson<{ url: string; expiresAt: number }>(
      "/api/creative-assets/link?" +
        new URLSearchParams({ project: asset.project, id: asset.id, version: asset.version }),
      "GET",
      undefined,
      signal,
    ),
  bundle: (project: string, id: string, version: string) =>
    "/api/creative-assets/export-bundle?" + new URLSearchParams({ project, id, version }),
  async inspectBundle(project: string, file: File, signal?: AbortSignal) {
    const response = await request("/api/creative-assets/bundle-inspection?" + new URLSearchParams({ project }), {
      method: "POST",
      body: file,
      headers: { "content-type": "application/octet-stream" },
      signal,
    });
    const value = await response.json();
    if (!response.ok) throw new DocumentApiError(response.status, value);
    return value as CreativeWebBundleInspection;
  },
  async import(
    project: string,
    file: File,
    title: string,
    locale: string,
    id: string,
    operationId: string,
    previous?: CreativeAsset,
    signal?: AbortSignal,
    entry?: string,
  ) {
    const bundle = file.name.toLowerCase().endsWith(".zip") && (!previous || previous.kind === "web"),
      kind = previous?.kind ?? creativeImportKind(file.name),
      response = await request(
        (bundle ? "/api/creative-assets/import-bundle?" : "/api/creative-assets/import?") +
          new URLSearchParams({
            project,
            id,
            operationId,
            kind,
            title,
            locale,
            name: file.name,
            ...(bundle ? { entry: entry ?? "" } : {}),
            ...(previous ? { version: previous.version } : {}),
          }),
        { method: "POST", body: file, headers: { "content-type": "application/octet-stream" }, signal },
      );
    const value = await response.json();
    if (!response.ok) throw new DocumentApiError(response.status, value);
    return value as { asset: CreativeAsset; commit: string };
  },
  copy: (asset: CreativeAsset, targetProject: string, targetId: string, operationId: string, signal?: AbortSignal) =>
    documentJson<{ asset: CreativeAsset }>(
      "/api/creative-assets/copy",
      "POST",
      {
        project: asset.project,
        id: asset.id,
        version: asset.version,
        targetProject,
        targetId,
        operationId,
      },
      signal,
    ),
  trash: (asset: CreativeAsset, operationId: string) =>
    documentJson<{ asset: CreativeAsset }>("/api/creative-assets/availability", "POST", {
      project: asset.project,
      id: asset.id,
      version: asset.version,
      state: "trashed",
      operationId,
    }),
  permanentDelete: (asset: CreativeAsset, operationId: string, signal?: AbortSignal) =>
    documentJson<CreativeAssetPurgeResult>(
      "/api/creative-assets/permanent-delete",
      "POST",
      {
        project: asset.project,
        id: asset.id,
        version: asset.version,
        operationId,
      },
      signal,
    ),
  purge: (asset: CreativeAsset, retry = false, signal?: AbortSignal) =>
    documentJson<CreativeAssetPurgeResult>(
      retry
        ? "/api/creative-assets/purge"
        : "/api/creative-assets/purge?" + new URLSearchParams({ project: asset.project, id: asset.id }),
      retry ? "POST" : "GET",
      retry ? { project: asset.project, id: asset.id } : undefined,
      signal,
    ),
  restore: (asset: CreativeAsset, operationId: string) =>
    documentJson<{ asset: CreativeAsset }>("/api/creative-assets/availability", "POST", {
      project: asset.project,
      id: asset.id,
      version: asset.version,
      state: "saved",
      operationId,
    }),
};
