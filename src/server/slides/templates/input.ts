import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import type { NativeSlidesSelection, NativeSlidesApproval } from "../../../shared/slides/registry.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { stageId } from "../../../shared/packages/stages/input.js";
import {
  templateObject,
  templateDigest,
  templateId,
  templateVersion,
} from "../../../shared/templates/portable/validation.js";
import { nativeSlidesSettings } from "./settings.js";

export function nativeSlidesActor(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new NativeSlidesTemplateError("invalidInput");
}
export function nativeSlidesRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new NativeSlidesTemplateError("invalidInput");
  return value;
}
export function nativeSlidesSelection(value: unknown): NativeSlidesSelection {
  const input = templateObject(value, ["kind", "path", "root"]);
  if (input.kind === "archive" && Object.keys(input).length === 1) return Object.freeze({ kind: "archive" });
  if (input.kind === "file" && !Object.hasOwn(input, "root"))
    return Object.freeze({ kind: "file", path: sourcePath(input.path) });
  if (input.kind === "bundle" && !Object.hasOwn(input, "path"))
    return Object.freeze({ kind: "bundle", root: input.root === "" ? "" : sourcePath(input.root) });
  throw new NativeSlidesTemplateError("invalidInput");
}
export function nativeSlidesSourceInput(value: unknown) {
  const source = templateObject(value, ["id", "sha256", "selection"]);
  return Object.freeze({
    id: stageId(source.id),
    sha256: templateDigest(source.sha256),
    selection: nativeSlidesSelection(source.selection),
  });
}
export function nativeSlidesDefinition(value: unknown) {
  if (value === null || value === undefined) return null;
  const definition = templateObject(value, ["settings", "mapping", "licenseText", "readmeText"]),
    settings = nativeSlidesSettings(definition.settings),
    raw = JSON.stringify(templateObject(definition.mapping, ["schema", "sourceSha256", "slots"]));
  if (
    Buffer.byteLength(raw) > 512 * 1024 ||
    typeof definition.licenseText !== "string" ||
    !definition.licenseText.length ||
    Buffer.byteLength(definition.licenseText) > 256 * 1024 ||
    typeof definition.readmeText !== "string" ||
    Buffer.byteLength(definition.readmeText) > 512 * 1024
  )
    throw new NativeSlidesTemplateError("invalidInput");
  return Object.freeze({
    settings,
    mapping: JSON.parse(raw) as unknown,
    licenseText: definition.licenseText,
    readmeText: definition.readmeText,
  });
}
export function nativeSlidesInstallInput(value: unknown, install: boolean) {
  const input = templateObject(value, install ? ["source", "definition", "approval"] : ["source", "definition"]),
    source = nativeSlidesSourceInput(input.source),
    definition = nativeSlidesDefinition(input.definition);
  let approval: NativeSlidesApproval | null = null;
  if (install) {
    const item = templateObject(input.approval, [
      "operationId",
      "expectedRevision",
      "reviewHash",
      "licenseAcknowledged",
    ]);
    if (item.licenseAcknowledged !== true) throw new NativeSlidesTemplateError("licenseNotAcknowledged");
    approval = Object.freeze({
      operationId: stageId(item.operationId),
      expectedRevision: nativeSlidesRevision(item.expectedRevision),
      reviewHash: templateDigest(item.reviewHash),
      licenseAcknowledged: true as const,
    });
  }
  return { source, definition, approval };
}
export function nativeSlidesReference(value: unknown) {
  const input = templateObject(value, ["id", "version", "digest"]);
  return { id: templateId(input.id), version: templateVersion(input.version), digest: templateDigest(input.digest) };
}
