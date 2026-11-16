import type { TemplateParameter } from "./contracts.js";
import { templateAssert } from "./errors.js";
import {
  templateBoolean,
  templateChoice,
  templateField,
  templateInteger,
  templateList,
  templateLocalized,
  templateNumber,
  templateObject,
  templateText,
  templateUnique,
} from "./validation.js";

export function templateParameter(value: unknown): TemplateParameter {
  const candidate = templateObject(value, [
    "id",
    "label",
    "required",
    "type",
    "maxLength",
    "minimum",
    "maximum",
    "options",
    "default",
  ]);
  const common = {
    id: templateField(candidate.id),
    label: templateLocalized(candidate.label),
    required: templateBoolean(candidate.required),
  };
  switch (templateChoice(candidate.type, ["text", "number", "boolean", "choice"])) {
    case "text": {
      const input = templateObject(candidate, ["id", "label", "required", "type", "maxLength", "default"]);
      const maxLength = input.maxLength === undefined ? undefined : templateInteger(input.maxLength, 1, 16000);
      const fallback = input.default === undefined ? undefined : templateText(input.default, maxLength ?? 16000, true);
      return {
        ...common,
        type: "text",
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    case "number": {
      const input = templateObject(candidate, ["id", "label", "required", "type", "minimum", "maximum", "default"]);
      const minimum = input.minimum === undefined ? undefined : templateNumber(input.minimum),
        maximum = input.maximum === undefined ? undefined : templateNumber(input.maximum),
        fallback = input.default === undefined ? undefined : templateNumber(input.default);
      templateAssert(minimum === undefined || maximum === undefined || minimum <= maximum);
      templateAssert(
        fallback === undefined ||
          ((minimum === undefined || fallback >= minimum) && (maximum === undefined || fallback <= maximum)),
      );
      return {
        ...common,
        type: "number",
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    case "boolean": {
      const input = templateObject(candidate, ["id", "label", "required", "type", "default"]);
      return {
        ...common,
        type: "boolean",
        ...(input.default === undefined ? {} : { default: templateBoolean(input.default) }),
      };
    }
    case "choice": {
      const input = templateObject(candidate, ["id", "label", "required", "type", "options", "default"]);
      const options = templateList(
        input.options,
        (value) => {
          const item = templateObject(value, ["value", "label"]);
          return { value: templateText(item.value, 160), label: templateLocalized(item.label) };
        },
        64,
        1,
      );
      templateUnique(options, (item) => item.value);
      const fallback = input.default === undefined ? undefined : templateText(input.default, 160);
      templateAssert(fallback === undefined || options.some((item) => item.value === fallback));
      return { ...common, type: "choice", options, ...(fallback === undefined ? {} : { default: fallback }) };
    }
  }
}
