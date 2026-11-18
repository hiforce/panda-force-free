import { CREATIVE_ASSET_KINDS } from "../../../shared/creative/assets.js";
import { creativeKindMatchesName } from "../../../shared/creative/file-types.js";
import { createHash } from "node:crypto";
import type { CreativeAsset, CreativeResource } from "../../../shared/creative/assets.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { stableJson } from "../../../shared/stable-json.js";
import {
  fileChoice,
  fileDigest,
  fileInteger,
  fileLocale,
  fileRecord,
  fileText,
} from "../../project-content/codec-values.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { decodeContentJson, encodeContentJson } from "../../project-content/json-file.js";
import { projectContentId } from "../../project-content/paths.js";

export const creativeDigest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function creativeAssetId(value: unknown) {
  const id = projectContentId(value);
  if (!/^c-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new ProjectContentError("invalidFile");
  return id;
}
export function creativeResourceName(value: unknown) {
  const name = fileText(value, 512);
  if (/[\\?#:%\p{Cc}\p{Cf}\p{Cs}]/u.test(name) || name.split("/").some((p) => !p || p.startsWith(".")))
    throw new ProjectContentError("invalidFile");
  return name;
}
function resource(value: unknown, maximum: number, minimum = 1): CreativeResource {
  const r = fileRecord(value, ["name", "digest", "size"]),
    size = fileInteger(r.size, minimum);
  if (size > maximum) throw new ProjectContentError("tooLarge");
  return { name: creativeResourceName(r.name), digest: fileDigest(r.digest), size };
}
export function creativeVersion(value: Omit<CreativeAsset, "version">) {
  return creativeDigest(stableJson(value));
}
export function creativeAsset(value: unknown): CreativeAsset {
  const v = fileRecord(value, [
    "schema",
    "id",
    "project",
    "kind",
    "title",
    "locale",
    "version",
    "previousVersion",
    "state",
    "source",
    "resources",
    "createdAt",
    "updatedAt",
    "copiedFrom",
    "originalStore",
    "hasObjectHistory",
    "purge",
  ]);
  if (v.schema !== 1 || !Array.isArray(v.resources) || v.resources.length > limits.resources)
    throw new ProjectContentError("invalidFile");
  const kind = fileChoice(v.kind, CREATIVE_ASSET_KINDS),
    source = resource(v.source, kind === "web" ? limits.htmlBytes : limits.sourceBytes),
    resources = v.resources.map((r) => resource(r, limits.resourceBytes, 0)),
    names = [source.name, ...resources.map((r) => r.name)].map((n) => n.toLowerCase());
  if (
    new Set(names).size !== names.length ||
    source.size + resources.reduce((n, r) => n + r.size, 0) > limits.totalBytes ||
    !creativeKindMatchesName(kind, source.name)
  )
    throw new ProjectContentError("invalidFile");
  let copiedFrom: CreativeAsset["copiedFrom"];
  if (v.copiedFrom !== undefined) {
    const p = fileRecord(v.copiedFrom, ["project", "id", "version", "commit"]),
      commit = fileText(p.commit, 40);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new ProjectContentError("invalidFile");
    copiedFrom = {
      project: projectContentId(p.project),
      id: creativeAssetId(p.id),
      version: fileDigest(p.version),
      commit,
    };
  }
  const state = fileChoice(v.state, ["saved", "trashed", "purging", "purged"]);
  if (
    (v.originalStore !== undefined && v.originalStore !== "object") ||
    (v.hasObjectHistory !== undefined && v.hasObjectHistory !== true) ||
    (v.originalStore === "object" && v.hasObjectHistory !== true) ||
    ["purging", "purged"].includes(state) !== (v.purge !== undefined)
  )
    throw new ProjectContentError("invalidFile");
  let purge: CreativeAsset["purge"];
  if (v.purge !== undefined) {
    const p = fileRecord(v.purge, ["operationId", "requestedVersion"]);
    purge = { operationId: projectContentId(p.operationId), requestedVersion: fileDigest(p.requestedVersion) };
  }
  const record: CreativeAsset = {
    schema: 1,
    id: creativeAssetId(v.id),
    project: projectContentId(v.project),
    kind,
    title: fileText(v.title, 800),
    locale: fileLocale(v.locale),
    version: fileDigest(v.version),
    previousVersion: v.previousVersion === null ? null : fileDigest(v.previousVersion),
    state,
    ...(v.originalStore === "object" ? { originalStore: "object" as const } : {}),
    ...(v.hasObjectHistory === true ? { hasObjectHistory: true as const } : {}),
    ...(purge ? { purge } : {}),
    source,
    resources,
    createdAt: fileInteger(v.createdAt),
    updatedAt: fileInteger(v.updatedAt),
    ...(copiedFrom ? { copiedFrom } : {}),
  };
  const { version, ...content } = record;
  if (record.updatedAt < record.createdAt || creativeVersion(content) !== version)
    throw new ProjectContentError("invalidFile");
  return record;
}
export const encodeCreativeAsset = (value: CreativeAsset) => encodeContentJson(value, creativeAsset);
export const decodeCreativeAsset = (bytes: Uint8Array | string) => decodeContentJson(bytes, creativeAsset);
