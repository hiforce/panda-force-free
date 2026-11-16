import type { DocumentAsset } from "../../shared/documents/contracts.js";
import { fileChoice, fileDigest, fileInteger, fileRecord, fileText } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import { projectContentId } from "./paths.js";
import { projectRecordShard, decodeProjectRecordShard } from "./record-shards.js";

export const PROJECT_ASSET_BYTES = 8 * 1024 * 1024;
export const projectAssetShard = projectRecordShard;
export const projectAssetFile = (id: string) => "asset-records/" + projectAssetShard(id) + ".panda.json";
export interface ProjectAssetRecords {
  schema: 1;
  projectId: string;
  shard: string;
  assets: DocumentAsset[];
}

export function decodeAssetRecord(value: unknown): DocumentAsset {
  const v = fileRecord(value, [
      "id",
      "documentId",
      "name",
      "mime",
      "digest",
      "size",
      "width",
      "height",
      "alt",
      "createdAt",
    ]),
    name = fileText(v.name, 960),
    size = fileInteger(v.size, 1),
    width = fileInteger(v.width, 1),
    height = fileInteger(v.height, 1);
  if (
    name.length > 240 ||
    name.startsWith(".") ||
    /[\\/]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    size > PROJECT_ASSET_BYTES ||
    width * height > 16_000_000
  )
    throw new ProjectContentError("invalidFile");
  return {
    id: projectContentId(v.id),
    documentId: projectContentId(v.documentId),
    name,
    mime: fileChoice(v.mime, ["image/png", "image/jpeg", "image/webp"]),
    digest: fileDigest(v.digest),
    size,
    width,
    height,
    alt: fileText(v.alt, 32000, true),
    createdAt: fileInteger(v.createdAt),
  };
}
function validate(value: unknown): ProjectAssetRecords {
  const { records, ...base } = decodeProjectRecordShard(value, "assets", decodeAssetRecord, (record) => record.id);
  return { ...base, assets: records };
}
export const encodeAssetRecords = (value: ProjectAssetRecords) => encodeContentJson(value, validate);
export const decodeAssetRecords = (bytes: Uint8Array | string) => decodeContentJson(bytes, validate);
