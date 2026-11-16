import {
  templateObject,
  templateId,
  templateVersion,
  templateDigest,
} from "../../../shared/templates/portable/validation.js";
import { buildId } from "../../../shared/builds/validation.js";
import { SiteBuildError } from "../errors.js";
import type { NativeSampleRequest, NativeBuildThemeRef } from "../../../shared/builds/native-samples.js";

export function nativeBuildActor(actor: unknown): asserts actor is string {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(actor))
    throw new SiteBuildError("notFound", 404);
}
export function nativeBuildThemeRef(value: unknown): NativeBuildThemeRef {
  try {
    const row = templateObject(value, ["id", "version", "digest"]);
    return Object.freeze({
      id: templateId(row.id),
      version: templateVersion(row.version),
      digest: templateDigest(row.digest),
    });
  } catch {
    throw new SiteBuildError("invalidInput");
  }
}
export function nativeSampleRequest(value: unknown): NativeSampleRequest {
  try {
    const row = templateObject(value, ["id", "theme"]);
    if (typeof row.id !== "string") throw new SiteBuildError("invalidInput");
    return Object.freeze({ id: buildId(row.id), theme: nativeBuildThemeRef(row.theme) });
  } catch {
    throw new SiteBuildError("invalidInput");
  }
}
