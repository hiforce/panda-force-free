/** Authored assets are saved originals, independent of installed skills, site themes and document bodies. */
export const CREATIVE_ASSET_KINDS = ["slides", "web", "image", "video", "file"] as const;
export type CreativeAssetKind = (typeof CREATIVE_ASSET_KINDS)[number];
export interface CreativeResource {
  name: string;
  digest: string;
  size: number;
}
export interface CreativeAsset {
  schema: 1;
  id: string;
  project: string;
  kind: CreativeAssetKind;
  title: string;
  locale: string;
  version: string;
  previousVersion: string | null;
  state: "saved" | "trashed" | "purging" | "purged";
  originalStore?: "object";
  hasObjectHistory?: true;
  purge?: { operationId: string; requestedVersion: string };
  source: CreativeResource;
  resources: CreativeResource[];
  createdAt: number;
  updatedAt: number;
  copiedFrom?: { project: string; id: string; version: string; commit: string };
}
export interface CreativeAssetPage {
  assets: CreativeAsset[];
  nextCursor: string | null;
}
export interface CreativeAssetDetail {
  asset: CreativeAsset;
  text: string;
  sections: { id: string; start: number; end: number }[];
  previewHtml?: string;
  previewTruncated?: boolean;
  previewUnavailable?: boolean;
}
export interface CreativeWebBundleInspection {
  schema: 1;
  entries: { name: string; size: number }[];
  defaultEntry: string | null;
  files: number;
  totalBytes: number;
}
export const CREATIVE_ASSET_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  previewBytes: 8 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  filePreviewCharacters: 32768,
  resourceBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  resources: 128,
  page: 50,
});

export interface CreativeAssetPurgeResult {
  asset: CreativeAsset;
  status: { state: "pending" | "complete"; code?: string };
}
