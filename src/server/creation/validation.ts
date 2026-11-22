import type { CreationProgress } from "../../shared/creation/contracts.js";
import { visibleTokenUsage } from "../../shared/engine/application-visible-events.js";
import { creationOperation } from "../../shared/creation/progress.js";
import { creationOutputType } from "./output-type.js";
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
export function creationNotificationPosition(cursor: string) {
  const fields = creationText(cursor, 80).split(".");
  if (fields.length !== 3 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[2]!))
    throw new CreationError("invalidInput");
  return {
    createdAt: creationInteger(Number(fields[0])),
    taskId: creationUuid(fields[1]),
    generation: creationInteger(Number(fields[2])),
  };
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
function creationLineageKey(value: unknown) {
  const key = creationText(value, 256);
  if (!/^[dt]:/.test(key)) throw new CreationError("invalidInput");
  creationId(key.slice(2));
  return key;
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
      "previousTaskId",
      "creationKey",
    ]),
    target = creationRecord(v.target, ["parentId", "treeVersion", "locale", "document", "documentProjectId"]),
    locale = creationText(target.locale, 35);
  if (v.schema !== 1 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) throw new CreationError("invalidInput");
  if (target.documentProjectId !== undefined && !target.document) throw new CreationError("invalidInput");
  return {
    schema: 1,
    id: creationUuid(v.id),
    owner: creationText(v.owner),
    projectId: creationId(v.projectId),
    operationId: creationUuid(v.operationId),
    kind: creationOutputType(v.kind),
    target: {
      parentId: target.parentId === null ? null : creationId(target.parentId),
      treeVersion: creationInteger(target.treeVersion),
      locale,
      ...(target.document === undefined ? {} : { document: creationDocumentReference(target.document) }),
      ...(target.documentProjectId === undefined ? {} : { documentProjectId: creationId(target.documentProjectId) }),
    },
    inputDigest: creationDigest(v.inputDigest),
    skillCaptureId: v.skillCaptureId === null ? null : creationUuid(v.skillCaptureId),
    ...(v.previousTaskId === undefined ? {} : { previousTaskId: creationUuid(v.previousTaskId) }),
    ...(v.creationKey === undefined ? {} : { creationKey: creationLineageKey(v.creationKey) }),
  };
}
export function creationArtifact(value: unknown, task: CreationTaskSpec): CreationArtifact {
  if (isRecord(value) && value.kind !== "document") return creationAssetArtifact(value, task);
  const v = creationRecord(value, [
    "kind",
    "projectId",
    "documentId",
    "operationId",
    "treeVersion",
    "title",
    "revisionId",
    "revision",
    "file",
    "location",
  ]);
  const file = v.file === undefined ? null : creationRecord(v.file, ["path", "format"]);
  const location =
    v.location === undefined
      ? null
      : creationRecord(v.location, ["projectId", "operationId", "treeVersion", "revisionId", "revision"]);
  if (location && (location.operationId !== task.operationId || Number(location.revision) !== Number(v.revision ?? 1)))
    throw new CreationError("conflict");
  if (
    file &&
    (file.format !== "markdown" ||
      !creationText(file.path, 4096).startsWith("/") ||
      /(?:^|\/)\.{1,2}(?:\/|$)|\\/.test(String(file.path)) ||
      !String(file.path).endsWith(".md"))
  )
    throw new CreationError("invalidInput");
  if (
    (task.kind !== "auto" && v.kind !== task.kind) ||
    v.projectId !== (task.target.documentProjectId ?? task.projectId) ||
    v.operationId !== task.operationId ||
    !Number.isSafeInteger(v.treeVersion) ||
    (task.target.document || (task.previousTaskId && v.revisionId)
      ? Number(v.treeVersion) < task.target.treeVersion
      : Number(v.treeVersion) <= task.target.treeVersion)
  )
    throw new CreationError("conflict");
  if (
    (v.revisionId === undefined) !== (v.revision === undefined) ||
    (v.revision !== undefined && (!Number.isSafeInteger(v.revision) || Number(v.revision) < 1))
  )
    throw new CreationError("conflict");
  if (
    task.target.document &&
    (v.documentId !== task.target.document.documentId ||
      !v.revisionId ||
      !Number.isSafeInteger(v.revision) ||
      Number(v.revision) < task.target.document.version)
  )
    throw new CreationError("conflict");
  return {
    kind: "document",
    projectId: creationId(v.projectId),
    operationId: task.operationId,
    documentId: creationId(v.documentId),
    treeVersion: creationInteger(v.treeVersion),
    ...(v.title === undefined ? {} : { title: creationText(v.title, 200) }),
    ...(v.revisionId === undefined ? {} : { revisionId: creationId(v.revisionId) }),
    ...(v.revision === undefined ? {} : { revision: creationInteger(v.revision) }),
    ...(file ? { file: { path: String(file.path), format: "markdown" as const } } : {}),
    ...(location
      ? {
          location: {
            projectId: creationId(location.projectId),
            operationId: creationUuid(location.operationId),
            treeVersion: creationInteger(location.treeVersion),
            revisionId: creationId(location.revisionId),
            revision: creationInteger(location.revision),
          },
        }
      : {}),
  };
}

export function creationAssetArtifact(
  value: unknown,
  task: Pick<CreationTaskSpec, "kind" | "projectId" | "operationId">,
): import("../../shared/creation/contracts.js").CreationAssetArtifact {
  const row = creationRecord(value, [
      "kind",
      "projectId",
      "assetId",
      "operationId",
      "version",
      "commit",
      "title",
      "source",
    ]),
    source = creationRecord(row.source, ["name", "digest", "size"]),
    kind = creationOutputType(row.kind),
    size = creationInteger(source.size),
    name = creationText(source.name, 512);
  if (
    kind === "auto" ||
    kind === "document" ||
    (task.kind !== "auto" && task.kind !== kind) ||
    row.projectId !== task.projectId ||
    row.operationId !== task.operationId ||
    row.assetId !== "c-" + task.operationId ||
    !size ||
    size > 32 * 1024 * 1024 ||
    /[\\/]/.test(name) ||
    !/^[a-f0-9]{40}$/.test(String(row.commit))
  )
    throw new CreationError("conflict");
  return {
    kind,
    projectId: task.projectId,
    assetId: String(row.assetId),
    operationId: task.operationId,
    version: creationDigest(row.version),
    commit: String(row.commit),
    title: creationText(row.title, 200),
    source: { name, digest: creationDigest(source.digest), size },
  };
}

/** Progress contains application stages and visible assistant messages, never reasoning or transport payloads. */
export function creationProgress(event: CreationProgress): CreationProgress {
  if (
    !Number.isSafeInteger(event.at) ||
    event.at < 0 ||
    !Number.isSafeInteger(event.generation) ||
    event.generation < 0 ||
    !["preparing", "started", "saving", "waiting", "answered", "message", "reply", "usage", "activity"].includes(
      event.stage,
    ) ||
    (event.stage === "activity"
      ? !creationOperation(event.operation) || !["running", "completed", "failed"].includes(event.status ?? "")
      : event.operation !== undefined || event.status !== undefined) ||
    (event.text !== undefined && (typeof event.text !== "string" || event.text.length > 65536)) ||
    (event.streaming !== undefined && typeof event.streaming !== "boolean")
  )
    throw new Error("Invalid creation progress");
  return {
    at: event.at,
    generation: event.generation,
    stage: event.stage,
    ...(event.text ? { text: event.text } : {}),
    ...(event.id === undefined ? {} : { id: creationUuid(event.id) }),
    ...(event.streaming === undefined ? {} : { streaming: event.streaming }),
    ...(event.usage === undefined ? {} : { usage: visibleTokenUsage(event.usage) }),
    ...(event.stage === "activity" ? { operation: event.operation, status: event.status } : {}),
  };
}

export function creationGoal(value: unknown): import("../../shared/creation/contracts.js").CreationGoal {
  const row = creationRecord(value, ["id", "objective", "status", "updatedAt"]);
  if (!["active", "paused", "blocked", "completed"].includes(String(row.status)))
    throw new CreationError("invalidInput");
  return {
    id: creationUuid(row.id),
    objective: creationGoalObjective(row.objective),
    status: row.status as import("../../shared/creation/contracts.js").CreationGoal["status"],
    updatedAt: creationInteger(row.updatedAt),
  };
}

export function creationGoalObjective(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 16000 ||
    /[\p{Cc}]/u.test(value.replace(/[\r\n\t]/g, ""))
  )
    throw new CreationError("invalidInput");
  return value.trim();
}

export function creationDocumentReference(
  value: unknown,
): import("../../shared/documents/contracts.js").DocumentRevisionReference {
  const row = creationRecord(value, ["documentId", "revisionId", "version", "contentHash"]),
    version = creationInteger(row.version);
  if (version < 1) throw new CreationError("invalidInput");
  return {
    documentId: creationId(row.documentId),
    revisionId: creationId(row.revisionId),
    version,
    contentHash: creationDigest(row.contentHash),
  };
}
