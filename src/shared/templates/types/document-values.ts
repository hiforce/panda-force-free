import type { DocumentLayoutTemplate } from "./contracts.js";
import type { PortableTemplateManifest } from "../portable/contracts.js";
import { templateAssert } from "../portable/errors.js";
import { templateObject, templateText } from "../portable/validation.js";

/** One value contract feeds native rich text and Markdown projections without reinterpreting inserted values. */
export function documentTemplateValues(
  model: Pick<DocumentLayoutTemplate, "contentSlots">,
  manifest: PortableTemplateManifest,
  input: unknown,
) {
  const parameters = new Map(manifest.parameters.map((parameter) => [parameter.id, parameter])),
    slots = new Map(model.contentSlots.map((slot) => [slot.id, slot]));
  const values = templateObject(input, [...parameters.keys(), ...slots.keys()]),
    resolved = new Map<string, { value: string; rich: boolean }>();
  for (const slot of model.contentSlots) {
    const value = values[slot.id] === undefined ? slot.default : templateText(values[slot.id], 64000, true);
    resolved.set(slot.id, { value, rich: slot.kind === "rich-text" });
  }
  for (const parameter of manifest.parameters) {
    const value = Object.hasOwn(values, parameter.id) ? values[parameter.id] : parameter.default;
    if (value === undefined) {
      templateAssert(!parameter.required, "invalidParameters");
      resolved.set(parameter.id, { value: "", rich: false });
      continue;
    }
    if (parameter.type === "text")
      resolved.set(parameter.id, {
        value: templateText(value, parameter.maxLength ?? 16000, !parameter.required),
        rich: false,
      });
    if (parameter.type === "choice") {
      templateAssert(
        typeof value === "string" && parameter.options.some((item) => item.value === value),
        "invalidParameters",
      );
      resolved.set(parameter.id, { value, rich: false });
    }
    if (parameter.type === "boolean") {
      templateAssert(typeof value === "boolean", "invalidParameters");
      resolved.set(parameter.id, { value: String(value), rich: false });
    }
    if (parameter.type === "number") {
      templateAssert(
        typeof value === "number" &&
          Number.isFinite(value) &&
          (parameter.minimum === undefined || value >= parameter.minimum) &&
          (parameter.maximum === undefined || value <= parameter.maximum),
        "invalidParameters",
      );
      resolved.set(parameter.id, { value: String(value), rich: false });
    }
  }
  return resolved;
}
