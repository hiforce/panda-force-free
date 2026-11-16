import { stableJson } from "../stable-json.js";
import {
  freezeTemplate,
  templateObject,
  templateId,
  templateVersion,
  templateDigest,
  templateText,
} from "./portable/validation.js";
import { templateAssert } from "./portable/errors.js";

export interface DocumentTemplateRequest {
  template: { id: string; version: string; digest: string };
  values: Record<string, string | number | boolean>;
}
export const DOCUMENT_TEMPLATE_INPUT_BYTES = 1024 * 1024;
/** Capture plain input before asynchronous work. A type adapter later validates declared fields and their semantics. */
export function documentTemplateRequest(input: unknown): DocumentTemplateRequest {
  const value = templateObject(input, ["template", "values"]),
    ref = templateObject(value.template, ["id", "version", "digest"]),
    template = { id: templateId(ref.id), version: templateVersion(ref.version), digest: templateDigest(ref.digest) };
  templateAssert(value.values && typeof value.values === "object" && !Array.isArray(value.values), "invalidParameters");
  const keys = Object.keys(value.values);
  templateAssert(keys.length <= 128, "invalidParameters");
  const supplied = templateObject(value.values, keys);
  const values = Object.fromEntries(
    Object.entries(supplied).map(([key, value]) => {
      templateAssert(key.length <= 80, "invalidParameters");
      if (typeof value === "string") templateText(value, 64000, true);
      else
        templateAssert(
          typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)),
          "invalidParameters",
        );
      return [key, value as string | number | boolean];
    }),
  );
  templateAssert(
    Object.keys(values).length <= 128 &&
      new TextEncoder().encode(stableJson(values)).length <= DOCUMENT_TEMPLATE_INPUT_BYTES,
    "invalidParameters",
  );
  return freezeTemplate({ template, values });
}
