import type { DocumentPlacement, DocumentPlacementEvent } from "../../shared/documents/placements.js";
import { publicDocumentMetadata, publicMetadataKeys } from "../../shared/sites/metadata.js";
import { metadataFieldNames } from "../../shared/sites/profile.js";
import { fileChoice, fileInteger, fileLocale, fileRecord, fileText } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import { projectContentId } from "./paths.js";
import { projectRecordShard, decodeProjectRecordShard } from "./record-shards.js";

export interface ProjectPlacementFile {
  schema: 1;
  placement: DocumentPlacement;
  audit: Omit<DocumentPlacementEvent, "placement">;
}
export const projectPlacementFile = (id: string) => "placements/" + projectRecordShard(id) + ".panda.json";
export function decodePlacementRecord(value: unknown): DocumentPlacement {
  const v = fileRecord(value, [
      "id",
      "projectId",
      "documentId",
      "spaceId",
      "path",
      "locale",
      "revisionId",
      "metadata",
      "version",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]),
    path = fileText(v.path, 2048);
  if (
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => !part || part.startsWith(".")) ||
    !/\.(md|mdx|markdown)$/i.test(path)
  )
    throw new ProjectContentError("invalidFile");
  let metadata: DocumentPlacement["metadata"];
  try {
    if (!v.metadata || typeof v.metadata !== "object" || Array.isArray(v.metadata))
      throw new ProjectContentError("invalidFile");
    const fields = metadataFieldNames(Object.keys(v.metadata).filter((key) => !publicMetadataKeys.includes(key)));
    // Historical custom fields remain readable even if a later publication profile removes those fields.
    metadata = publicDocumentMetadata(v.metadata, fields);
  } catch {
    throw new ProjectContentError("invalidFile");
  }
  return {
    id: projectContentId(v.id),
    projectId: projectContentId(v.projectId),
    documentId: projectContentId(v.documentId),
    spaceId: projectContentId(v.spaceId),
    path,
    locale: fileLocale(v.locale),
    revisionId: v.revisionId === null ? null : projectContentId(v.revisionId),
    metadata,
    version: fileInteger(v.version, 1),
    createdAt: fileInteger(v.createdAt),
    updatedAt: fileInteger(v.updatedAt),
    deletedAt: v.deletedAt === null ? null : fileInteger(v.deletedAt),
  };
}
function validate(value: unknown): ProjectPlacementFile {
  const v = fileRecord(value, ["schema", "placement", "audit"]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const placement = decodePlacementRecord(v.placement),
    audit = fileRecord(v.audit, ["operation", "actor", "createdAt"]),
    operation = fileChoice(audit.operation, ["create", "update", "remove"]);
  if (
    (operation === "remove") !== (placement.deletedAt !== null) ||
    (operation === "create") !== (placement.version === 1)
  )
    throw new ProjectContentError("invalidFile");
  return {
    schema: 1,
    placement,
    audit: { operation, actor: fileText(audit.actor, 800), createdAt: fileInteger(audit.createdAt) },
  };
}
export const encodeProjectPlacement = (value: ProjectPlacementFile) => encodeContentJson(value, validate);
export const decodeProjectPlacement = (bytes: Uint8Array | string) => decodeContentJson(bytes, validate);

export interface ProjectPlacementRecords {
  schema: 1;
  projectId: string;
  shard: string;
  placements: ProjectPlacementFile[];
}
function validateRecords(value: unknown): ProjectPlacementRecords {
  const v = decodeProjectRecordShard(value, "placements", validate, (record) => record.placement.id),
    { records, ...base } = v;
  if (records.some((record) => record.placement.projectId !== base.projectId))
    throw new ProjectContentError("invalidFile");
  return { ...base, placements: records };
}
export const encodePlacementRecords = (value: ProjectPlacementRecords) => encodeContentJson(value, validateRecords);
export const decodePlacementRecords = (bytes: Uint8Array | string) => decodeContentJson(bytes, validateRecords);
