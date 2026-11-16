import type { DocumentTreeReceipt } from "../../shared/documents/navigation.js";
import { fileDigest, fileInteger, fileRecord, fileText } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import { projectContentId } from "./paths.js";
import { decodeNavigationReceipt } from "./navigation-file.js";
import { projectRecordShard, decodeProjectRecordShard } from "./record-shards.js";

export interface ProjectNavigationOperation {
  id: string;
  spaceId: string;
  owner: string;
  request: string;
  legacyRequest?: true;
  documentId: string;
  createdAt: number;
  result: DocumentTreeReceipt | null;
}
export interface ProjectNavigationOperationFile {
  schema: 1;
  projectId: string;
  shard: string;
  operations: ProjectNavigationOperation[];
}
export const navigationOperationShard = projectRecordShard;
export const navigationOperationFile = (id: string) =>
  "navigation-operations/" + navigationOperationShard(id) + ".panda.json";
export function decodeNavigationOperation(value: unknown): ProjectNavigationOperation {
  const v = fileRecord(value, [
      "id",
      "spaceId",
      "owner",
      "request",
      "legacyRequest",
      "documentId",
      "createdAt",
      "result",
    ]),
    id = projectContentId(v.id),
    documentId = projectContentId(v.documentId),
    result = decodeNavigationReceipt(v.result);
  if (result !== null && (result.id !== id || result.documentId !== documentId))
    throw new ProjectContentError("invalidFile");
  if (v.legacyRequest !== undefined && v.legacyRequest !== true) throw new ProjectContentError("invalidFile");
  return {
    id,
    documentId,
    spaceId: projectContentId(v.spaceId),
    owner: fileText(v.owner, 800),
    request: v.legacyRequest === true ? fileText(v.request, 16 * 1024 * 1024) : fileDigest(v.request),
    ...(v.legacyRequest === true ? { legacyRequest: true as const } : {}),
    createdAt: fileInteger(v.createdAt),
    result,
  };
}
function validate(value: unknown): ProjectNavigationOperationFile {
  const { records, ...base } = decodeProjectRecordShard(
    value,
    "operations",
    decodeNavigationOperation,
    (record) => record.id,
  );
  return { ...base, operations: records };
}
export const encodeNavigationOperations = (value: ProjectNavigationOperationFile) => encodeContentJson(value, validate);
export const decodeNavigationOperations = (bytes: Uint8Array | string) => decodeContentJson(bytes, validate);
