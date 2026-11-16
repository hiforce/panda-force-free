import { NativeThemeError, type NativeThemeApproval } from "../../../shared/templates/native/contracts.js";
import { nativeThemeSettings } from "../../../shared/templates/native/settings.js";
import {
  templateObject,
  templateDigest,
  templateId,
  templateVersion,
} from "../../../shared/templates/portable/validation.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { stageId } from "../../../shared/packages/stages/input.js";

export function nativeActor(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new NativeThemeError("invalidInput");
}
export function nativeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new NativeThemeError("invalidInput");
  return value;
}
export function nativeInstallCommand(value: unknown, install: boolean) {
  const input = templateObject(value, install ? ["source", "settings", "approval"] : ["source", "settings"]),
    source = nativeSourceSelection(input.source);
  let approval: NativeThemeApproval | null = null;
  if (install) {
    const item = templateObject(input.approval, [
      "operationId",
      "expectedRevision",
      "reviewHash",
      "permissions",
      "licenseAcknowledged",
    ]);
    if (item.licenseAcknowledged !== true || JSON.stringify(item.permissions) !== '["build:theme-code"]')
      throw new NativeThemeError("executionNotApproved");
    approval = Object.freeze({
      operationId: stageId(item.operationId),
      expectedRevision: nativeRevision(item.expectedRevision),
      reviewHash: templateDigest(item.reviewHash),
      permissions: Object.freeze(["build:theme-code"] as const),
      licenseAcknowledged: true,
    });
  }
  return Object.freeze({
    source,
    settings: nativeThemeSettings(input.settings),
    approval,
  });
}
export function nativeSourceSelection(value: unknown) {
  const source = templateObject(value, ["id", "sha256", "root"]);
  return Object.freeze({
    id: stageId(source.id),
    sha256: templateDigest(source.sha256),
    root: source.root === "" ? "" : sourcePath(source.root),
  });
}
export function nativeThemeReference(value: unknown) {
  const input = templateObject(value, ["id", "version", "digest"]);
  return { id: templateId(input.id), version: templateVersion(input.version), digest: templateDigest(input.digest) };
}
