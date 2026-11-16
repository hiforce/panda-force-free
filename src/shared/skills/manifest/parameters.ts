import type { SkillParameter } from "../contracts.js";
import { skillAssert } from "../errors.js";
import { localId, localized } from "./identity.js";
import { boolean, finite, list, oneOf, record, text, unique } from "./primitives.js";
export function parameter(value: unknown): SkillParameter {
  const base = record(value, ["id", "label", "required", "type", "maxLength", "minimum", "maximum", "options"]);
  const type = oneOf(base.type, ["text", "number", "boolean", "choice"], "parameters.type");
  const fields = [
    "id",
    "label",
    "required",
    "type",
    ...(type === "text"
      ? ["maxLength"]
      : type === "number"
        ? ["minimum", "maximum"]
        : type === "choice"
          ? ["options"]
          : []),
  ];
  record(base, fields);
  const common = {
    id: localId(base.id),
    label: localized(base.label, 160),
    required: boolean(base.required, "parameters.required"),
  };
  if (type === "text") {
    const maxLength = base.maxLength === undefined ? undefined : finite(base.maxLength, "parameters.maxLength");
    skillAssert(
      maxLength === undefined || (Number.isInteger(maxLength) && maxLength > 0 && maxLength <= 4000),
      "invalidManifest",
      "parameters.maxLength",
    );
    return { ...common, type, ...(maxLength === undefined ? {} : { maxLength }) };
  }
  if (type === "number") {
    const minimum = base.minimum === undefined ? undefined : finite(base.minimum, "parameters.minimum"),
      maximum = base.maximum === undefined ? undefined : finite(base.maximum, "parameters.maximum");
    skillAssert(
      minimum === undefined || maximum === undefined || minimum <= maximum,
      "invalidManifest",
      "parameters.range",
    );
    return {
      ...common,
      type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    };
  }
  if (type === "boolean") return { ...common, type };
  const options = list(
    base.options,
    (item) => {
      const row = record(item, ["value", "label"]);
      return { value: text(row.value, 120), label: localized(row.label, 160) };
    },
    1,
    32,
    "parameters.options",
  );
  unique(options, (item) => item.value, "parameters.options");
  return { ...common, type, options };
}
