import { NativeSlidesTemplateError, type NativeSlidesSettings } from "../../../shared/slides/templates.js";
import {
  templateObject,
  templateId,
  templateVersion,
  templateText,
  templateLocalized,
  freezeTemplate,
} from "../../../shared/templates/portable/validation.js";

export function nativeSlidesSettings(input: unknown): NativeSlidesSettings {
  try {
    const value = templateObject(input, ["schema", "id", "version", "name", "description", "publisher", "license"]);
    if (value.schema !== 1) throw new NativeSlidesTemplateError("invalidInput");
    const localized = (raw: unknown) =>
      Object.fromEntries(Object.entries(templateLocalized(raw)).sort(([a], [b]) => a.localeCompare(b, "en")));
    return freezeTemplate({
      schema: 1,
      id: templateId(value.id),
      version: templateVersion(value.version),
      name: localized(value.name),
      description: localized(value.description),
      publisher: templateText(value.publisher, 200),
      license: templateText(value.license, 200),
    });
  } catch (error) {
    if (error instanceof NativeSlidesTemplateError) throw error;
    throw new NativeSlidesTemplateError("invalidInput");
  }
}
