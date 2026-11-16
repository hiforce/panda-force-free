import { isRecord } from "../../shared/records.js";
import { CreationError, type CreationArtifact, type CreationTaskSpec } from "./contracts.js";

export function creationRecord(value: unknown, keys: readonly string[]) {
  if (
    !isRecord(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new CreationError("invalidInput");
  return value;
}
export function creationText(value: unknown, max = 800): string {
  if (typeof value !== "string" || !value || value.length > max || /[\p{Cc}]/u.test(value))
    throw new CreationError("invalidInput");
  return value;
}
export function creationId(value: unknown): string {
  const id = creationText(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new CreationError("invalidInput");
  return id;
}
export function creationUuid(value: unknown): string {
  const id = creationText(value, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new CreationError("invalidInput");
  return id;
}
export function creationDigest(value: unknown): string {
  const digest = creationText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new CreationError("invalidInput");
  return digest;
}
export function creationInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CreationError("invalidInput");
  return Number(value);
}
export function creationUuidFromDigest(value: string): string {
  const hex = creationDigest(value);
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-5" +
    hex.slice(13, 16) +
    "-a" +
    hex.slice(17, 20) +
    "-" +
    hex.slice(20, 32)
  );
}
export function creationTaskSpec(value: unknown): CreationTaskSpec {
  const v = creationRecord(value, [
      "schema",
      "id",
      "owner",
      "projectId",
      "operationId",
      "kind",
      "target",
      "inputDigest",
      "skillCaptureId",
    ]),
    target = creationRecord(v.target, ["parentId", "treeVersion", "locale"]),
    locale = creationText(target.locale, 35);
  if (v.schema !== 1 || v.kind !== "document" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale))
    throw new CreationError("invalidInput");
  return {
    schema: 1,
    id: creationUuid(v.id),
    owner: creationText(v.owner),
    projectId: creationId(v.projectId),
    operationId: creationUuid(v.operationId),
    kind: "document",
    target: {
      parentId: target.parentId === null ? null : creationId(target.parentId),
      treeVersion: creationInteger(target.treeVersion),
      locale,
    },
    inputDigest: creationDigest(v.inputDigest),
    skillCaptureId: v.skillCaptureId === null ? null : creationUuid(v.skillCaptureId),
  };
}
export function creationArtifact(value: unknown, task: CreationTaskSpec): CreationArtifact {
  const v = creationRecord(value, ["kind", "projectId", "documentId", "operationId", "treeVersion"]);
  if (
    v.kind !== task.kind ||
    v.projectId !== task.projectId ||
    v.operationId !== task.operationId ||
    !Number.isSafeInteger(v.treeVersion) ||
    Number(v.treeVersion) <= task.target.treeVersion
  )
    throw new CreationError("conflict");
  return {
    kind: "document",
    projectId: task.projectId,
    operationId: task.operationId,
    documentId: creationId(v.documentId),
    treeVersion: creationInteger(v.treeVersion),
  };
}
