import type { SkillDefinition } from "./contracts.js";
import { skillAssert } from "./errors.js";
import { record } from "./manifest/primitives.js";
export type SkillParameterValues = Readonly<Record<string, string | number | boolean>>;
/** Parameter identities are scoped to a selected skill, never flattened into one shared namespace. */
export function skillParameterValues(skill: SkillDefinition, value: unknown): SkillParameterValues {
  const input = record(
      value,
      skill.parameters.map((item) => item.id),
      "parameters",
      "invalidParameters",
    ),
    result: Record<string, string | number | boolean> = {};
  for (const parameter of skill.parameters) {
    const supplied = input[parameter.id];
    if (supplied === undefined) {
      skillAssert(!parameter.required, "invalidParameters", parameter.id);
      continue;
    }
    if (parameter.type === "text")
      skillAssert(
        typeof supplied === "string" &&
          supplied.length <= (parameter.maxLength || 4000) &&
          (!parameter.required || !!supplied.trim()) &&
          !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(supplied.replace(/[\t\n\r]/g, "")),
        "invalidParameters",
        parameter.id,
      );
    else if (parameter.type === "boolean")
      skillAssert(typeof supplied === "boolean", "invalidParameters", parameter.id);
    else if (parameter.type === "number")
      skillAssert(
        typeof supplied === "number" &&
          Number.isFinite(supplied) &&
          (parameter.minimum === undefined || supplied >= parameter.minimum) &&
          (parameter.maximum === undefined || supplied <= parameter.maximum),
        "invalidParameters",
        parameter.id,
      );
    else
      skillAssert(
        typeof supplied === "string" && parameter.options.some((item) => item.value === supplied),
        "invalidParameters",
        parameter.id,
      );
    skillAssert(
      typeof supplied === "string" || typeof supplied === "number" || typeof supplied === "boolean",
      "invalidParameters",
      parameter.id,
    );
    result[parameter.id] = supplied;
  }
  return Object.freeze(result);
}
