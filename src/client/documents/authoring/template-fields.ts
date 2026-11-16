import { escapeHtml as e } from "../../../shared/html.js";
import type { PortableTemplateManifest } from "../../../shared/templates/portable/contracts.js";
import type { DocumentLayoutTemplate, RichDocumentLayoutTemplate } from "../../../shared/templates/types/contracts.js";
import type { DocumentTemplateRequest } from "../../../shared/templates/application.js";
import type { Translate } from "../../../shared/i18n/messages.js";

export const templateText = (value: Readonly<Record<string, string>>) =>
  value[document.documentElement.lang] || value[document.documentElement.lang.split("-")[0]!] || value.en || "";

/** Parameters and content slots keep their declared types; empty optional inputs use the template's defaults. */
export function applicationFields(
  t: Translate,
  manifest: PortableTemplateManifest,
  model: DocumentLayoutTemplate | RichDocumentLayoutTemplate,
) {
  const field = (id: string, label: string, html: string) =>
    `<label for="apply-template-${e(id)}"><span>${e(label)}</span></label>${html}`;
  return (
    manifest.parameters
      .map((parameter) => {
        const id = `id="apply-template-${e(parameter.id)}" name="template-value-${e(parameter.id)}"`,
          required = parameter.required ? "required" : "",
          fallback = parameter.default;
        let html: string;
        if (parameter.type === "choice" || parameter.type === "boolean") {
          const options =
            parameter.type === "choice"
              ? parameter.options.map((option) => ({ value: option.value, label: templateText(option.label) }))
              : [
                  { value: "true", label: t("templates.trueValue") },
                  { value: "false", label: t("templates.falseValue") },
                ];
          html = `<select ${id} ${required}><option value=""></option>${options.map((option) => `<option value="${e(option.value)}" ${String(fallback) === option.value ? "selected" : ""}>${e(option.label)}</option>`).join("")}</select>`;
        } else
          html = `<input ${id} ${required} value="${e(fallback === undefined ? "" : String(fallback))}" ${parameter.type === "number" ? `type="number" step="any" ${parameter.minimum === undefined ? "" : `min="${parameter.minimum}"`} ${parameter.maximum === undefined ? "" : `max="${parameter.maximum}"`}` : `maxlength="${parameter.maxLength || 16000}"`}>`;
        return field(parameter.id, templateText(parameter.label), html);
      })
      .join("") +
    model.contentSlots
      .map((slot) =>
        field(
          slot.id,
          slot.id,
          `<textarea id="apply-template-${e(slot.id)}" name="template-value-${e(slot.id)}" rows="3" maxlength="64000">${e(slot.default)}</textarea>`,
        ),
      )
      .join("")
  );
}
export function readApplicationFields(
  fields: Record<string, string>,
  manifest: PortableTemplateManifest,
  model: DocumentLayoutTemplate | RichDocumentLayoutTemplate,
) {
  const values: DocumentTemplateRequest["values"] = {};
  for (const parameter of manifest.parameters) {
    const raw = fields["template-value-" + parameter.id] || "";
    if (!raw && !parameter.required) continue;
    values[parameter.id] =
      parameter.type === "number" ? Number(raw) : parameter.type === "boolean" ? raw === "true" : raw;
  }
  for (const slot of model.contentSlots) values[slot.id] = fields["template-value-" + slot.id] || "";
  return values;
}
