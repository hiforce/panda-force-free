import { sourceLimits, type SourceLimits } from "../sources/contracts.js";
import { githubSourceRequest } from "../sources/github.js";
import { sourceOrigin } from "../sources/origin.js";
import { SourcePaths, sourcePath } from "../sources/paths.js";
import { SourceStageError, type SourceStageRequest, type SourceStagePurpose } from "./contracts.js";

export function stageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))
    throw new SourceStageError("stageInvalidInput");
  return value;
}
export function stageId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    throw new SourceStageError("stageInvalidInput");
  return value;
}
export function stageRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new SourceStageError("stageInvalidInput");
  return Number(value);
}
export function stagePurpose(value: unknown): SourceStagePurpose {
  if (value !== "templates" && value !== "skills") throw new SourceStageError("stageInvalidInput");
  return value;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new SourceStageError("stageInvalidInput");
  return value as Record<string, unknown>;
}

/** Source intent contains connection references only; uploaded or caller-supplied secrets are not accepted. */
export function sourceStageRequest(value: unknown, options?: SourceLimits): SourceStageRequest {
  const limits = sourceLimits(options),
    input = object(value, ["source", "selected"]),
    source = object(input.source, [
      "kind",
      "name",
      "bytes",
      "sha256",
      "repository",
      "ref",
      "root",
      "connectionId",
      "repositoryId",
    ]);
  let captured: SourceStageRequest["source"];
  if (source.kind === "zip-upload") {
    object(source, ["kind", "name", "bytes", "sha256"]);
    const origin = sourceOrigin({ kind: "zip-upload", name: source.name, archiveSha256: source.sha256 });
    if (
      origin.kind !== "zip-upload" ||
      !Number.isSafeInteger(source.bytes) ||
      Number(source.bytes) < 0 ||
      Number(source.bytes) > limits.archiveBytes
    )
      throw new SourceStageError("stageInvalidInput");
    captured = Object.freeze({
      kind: "zip-upload",
      name: origin.name,
      bytes: Number(source.bytes),
      sha256: origin.archiveSha256,
    });
  } else {
    object(source, ["kind", "repository", "ref", "root", "connectionId", "repositoryId"]);
    if (
      source.kind !== "github" ||
      (source.repositoryId != null && (!Number.isSafeInteger(source.repositoryId) || Number(source.repositoryId) < 1))
    )
      throw new SourceStageError("stageInvalidInput");
    const request = githubSourceRequest({
      repository: source.repository,
      ...(source.ref == null ? {} : { ref: source.ref }),
      ...(source.root === undefined ? {} : { root: source.root }),
      ...(source.connectionId == null ? {} : { connectionId: source.connectionId }),
    });
    captured = Object.freeze({
      kind: "github",
      repository: request.repository.url,
      ref: request.ref ?? null,
      root: request.root,
      connectionId: request.connectionId ?? null,
      repositoryId: source.repositoryId == null ? null : Number(source.repositoryId),
    });
  }
  const paths = new SourcePaths(limits.entries);
  if (input.selected != null && (!Array.isArray(input.selected) || input.selected.length > limits.files))
    throw new SourceStageError("stageInvalidInput");
  const selected =
    input.selected == null
      ? null
      : Object.freeze((input.selected as unknown[]).map((path) => paths.add(sourcePath(path))).sort());
  return Object.freeze({ source: captured, selected });
}
