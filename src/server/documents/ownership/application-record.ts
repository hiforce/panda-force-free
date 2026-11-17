import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { isRecord } from "../../../shared/records.js";
import { projectContentId } from "../../project-content/paths.js";
import { documentAuthor, documentOperationUuid } from "../files/commands.js";
import { DocumentError } from "../errors.js";
import { fileOwnershipInventory, assertOwnershipPlan } from "./plan.js";
import type { AdmittedDocumentOwnership, DocumentOwnershipRequest } from "./application-contracts.js";
const keys = (value: unknown, allowed: string[]) => {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new DocumentError("invalidInput");
  return value;
};
export function documentOwnershipRequest(value: unknown): DocumentOwnershipRequest {
  const v = keys(value, ["owner", "operationId", "fromProjectId", "toProjectId", "parentId", "expected"]),
    base = keys(v.expected, ["documentId", "revision", "revisionId", "contentHash"]);
  if (typeof v.owner !== "string" || !v.owner || v.owner.length > 200 || /[\p{Cc}]/u.test(v.owner))
    throw new DocumentError("invalidInput");
  documentAuthor(v.owner);
  if (
    !Number.isSafeInteger(base.revision) ||
    Number(base.revision) < 1 ||
    typeof base.contentHash !== "string" ||
    !/^([a-f0-9]{64})$/.test(base.contentHash)
  )
    throw new DocumentError("invalidInput");
  const request: DocumentOwnershipRequest = {
    owner: v.owner,
    operationId: documentOperationUuid(v.operationId),
    fromProjectId: projectContentId(v.fromProjectId),
    toProjectId: projectContentId(v.toProjectId),
    parentId: v.parentId === null ? null : projectContentId(v.parentId),
    expected: {
      documentId: projectContentId(base.documentId),
      revision: Number(base.revision),
      contentHash: base.contentHash,
      ...(base.revisionId === undefined ? {} : { revisionId: projectContentId(base.revisionId) }),
    },
  };
  if (request.fromProjectId === request.toProjectId) throw new DocumentError("invalidInput");
  return request;
}
export const ownershipRequestKey = (owner: string, operationId: string) =>
  createHash("sha256")
    .update(stableJson({ purpose: "document-ownership-admission", owner, operationId }))
    .digest("hex");
export function admittedOwnership(value: unknown): AdmittedDocumentOwnership {
  const v = keys(value, ["schema", "request", "plan", "source"]),
    request = documentOwnershipRequest(v.request),
    s = keys(v.source, ["kind", "snapshot"]);
  if (v.schema !== 1 || !["files", "sql"].includes(String(s.kind)) || !isRecord(s.snapshot) || !isRecord(v.plan))
    throw new DocumentError("invalidInput");
  const record = structuredClone({
      schema: 1,
      request,
      plan: v.plan,
      source: s,
    }) as unknown as AdmittedDocumentOwnership,
    inventory =
      record.source.kind === "files"
        ? fileOwnershipInventory(record.source.snapshot)
        : record.source.snapshot.inventory;
  assertOwnershipPlan(record.plan, inventory);
  if (
    record.plan.owner !== request.owner ||
    record.plan.id !== request.operationId ||
    record.plan.from.projectId !== request.fromProjectId ||
    record.plan.to.projectId !== request.toProjectId ||
    record.plan.parentId !== request.parentId ||
    inventory.rootDocumentId !== request.expected.documentId
  )
    throw new DocumentError("invalidInput");
  const root = inventory.nodes.find((node) => node.documentId === inventory.rootDocumentId)!.document;
  if (
    root.revision !== request.expected.revision ||
    root.contentHash !== request.expected.contentHash ||
    (request.expected.revisionId && root.revisionId !== request.expected.revisionId)
  )
    throw new DocumentError("conflict", 409);
  return record;
}
