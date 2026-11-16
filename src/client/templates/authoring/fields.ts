import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentTemplateDefinition } from "../../../shared/templates/authoring/contracts.js";
import type { TemplateParameter, LocalizedTemplateText } from "../../../shared/templates/portable/contracts.js";
import { escapeHtml as e } from "../../../shared/html.js";

import { SUPPORTED_LOCALES } from "../../../shared/i18n/locale-policy.js";
export const fieldValue = (host: ParentNode, name: string) =>
  host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${name}"]`)?.value || "";
export function templateField(label: string, name: string, value: string, attributes = "", multiline = false) {
  return `<label class="template-authoring-field"><span>${e(label)}</span>${multiline ? `<textarea data-field="${name}" ${attributes}>${e(value)}</textarea>` : `<input data-field="${name}" value="${e(value)}" ${attributes}>`}</label>`;
}
export function localizedField(_t: Translate, label: string, prefix: string, value: LocalizedTemplateText) {
  const codes = [...new Set(["en", ...SUPPORTED_LOCALES.map((locale) => locale.code), ...Object.keys(value)])];
  return `<div class="template-localized-fields" data-template-localized="${prefix}">${codes
    .map((code) => {
      const locale = SUPPORTED_LOCALES.find((item) => item.code === code);
      return `<label class="template-authoring-field"><span>${e(label)} · ${e(locale?.name || code)}</span><input data-template-locale="${e(code)}" data-field="${prefix}-${e(code)}" value="${e(value[code] || "")}" lang="${e(code)}" dir="${e(locale?.direction || "ltr")}" ${code === "en" ? "required" : ""} maxlength="2000"></label>`;
    })
    .join("")}</div>`;
}
export function readLocalized(
  host: ParentNode,
  prefix: string,
  previous: LocalizedTemplateText = {},
): LocalizedTemplateText {
  const result: Record<string, string> = { ...previous },
    group = host.querySelector(`[data-template-localized="${prefix}"]`);
  if (!group) return result;
  for (const input of group.querySelectorAll<HTMLInputElement>("[data-template-locale]")) {
    const locale = input.dataset.templateLocale!;
    if (input.value || locale === "en") result[locale] = input.value;
    else delete result[locale];
  }
  return result;
}
export function metadataFields(t: Translate, value: DocumentTemplateDefinition) {
  return `${localizedField(t, t("templates.draftName"), "name", value.name)}${localizedField(t, t("templates.draftDescription"), "description", value.description)}${templateField(t("templates.draftId"), "id", value.id, 'required maxlength="80"')}${templateField(t("templates.version"), "version", value.version, 'required maxlength="20"')}<details><summary>${e(t("templates.draftMetadata"))}</summary>${templateField(t("templates.publisher"), "publisher", value.publisher.name, 'required maxlength="160"')}${templateField(t("templates.publisherHomepage"), "homepage", value.publisher.homepage || "", 'type="url" maxlength="1000"')}${templateField(t("templates.categories"), "categories", value.categories.join(", "), 'required maxlength="1200"')}${templateField(t("templates.tags"), "tags", value.tags.join(", "), 'maxlength="2400"')}${templateField(t("templates.license"), "license", value.license.expression, 'required maxlength="120"')}${templateField(t("templates.licenseText"), "license-text", value.license.text, 'required rows="5" maxlength="64000"', true)}</details>`;
}
export function readMetadata(host: ParentNode, previous: DocumentTemplateDefinition) {
  const homepage = fieldValue(host, "homepage");
  return {
    ...previous,
    id: fieldValue(host, "id"),
    version: fieldValue(host, "version"),
    name: readLocalized(host, "name", previous.name),
    description: readLocalized(host, "description", previous.description),
    publisher: { name: fieldValue(host, "publisher"), ...(homepage ? { homepage } : {}) },
    categories: fieldValue(host, "categories")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    tags: fieldValue(host, "tags")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    license: { expression: fieldValue(host, "license"), text: fieldValue(host, "license-text") },
  };
}
export function optionRow(t: Translate, value: { value: string; label: LocalizedTemplateText }, index: number) {
  return `<fieldset data-choice-index="${index}">${templateField(t("templates.choiceValue"), "choice-value", value.value, 'required maxlength="160"')}${localizedField(t, t("templates.parameterLabel"), "choice-label", value.label)}<button type="button" class="wb-button danger" data-authoring-field-action="remove-choice">${e(t("templates.removeField"))}</button></fieldset>`;
}
export function parameterTypeFields(t: Translate, value: TemplateParameter) {
  if (value.type === "text")
    return `${templateField(t("templates.defaultValue"), "default", value.default ?? "", 'maxlength="16000"')}${templateField(t("templates.maximumLength"), "maxLength", value.maxLength === undefined ? "" : String(value.maxLength), 'type="number" min="1" max="16000"')}`;
  if (value.type === "number")
    return ["default", "minimum", "maximum"]
      .map((name) =>
        templateField(
          t(
            name === "default"
              ? "templates.defaultValue"
              : name === "minimum"
                ? "templates.minimumValue"
                : "templates.maximumValue",
          ),
          name,
          value[name as "default" | "minimum" | "maximum"] === undefined
            ? ""
            : String(value[name as "default" | "minimum" | "maximum"]),
          'type="number" step="any"',
        ),
      )
      .join("");
  if (value.type === "boolean")
    return `<label class="template-authoring-field"><span>${e(t("templates.defaultValue"))}</span><select data-field="default"><option value="">${e(t("templates.noDefault"))}</option><option value="true" ${value.default === true ? "selected" : ""}>${e(t("templates.trueValue"))}</option><option value="false" ${value.default === false ? "selected" : ""}>${e(t("templates.falseValue"))}</option></select></label>`;
  return `<div data-parameter-options>${value.options.map((item, index) => optionRow(t, item, index)).join("")}</div><button type="button" class="wb-button" data-authoring-field-action="add-choice">${e(t("templates.addChoice"))}</button>${templateField(t("templates.defaultValue"), "default", value.default ?? "", 'maxlength="160"')}`;
}
export function parameterRow(t: Translate, value: TemplateParameter, index: number) {
  return `<fieldset class="template-parameter-row" data-parameter-index="${index}"><legend>${e(t("templates.parameter"))} ${index + 1}</legend>${templateField(t("templates.parameterId"), "parameter-id", value.id, 'required maxlength="64"')}${localizedField(t, t("templates.parameterLabel"), "parameter-label", value.label)}<label class="template-authoring-field"><span>${e(t("templates.parameterType"))}</span><select data-field="parameter-type">${(["text", "number", "boolean", "choice"] as const).map((type) => `<option value="${type}" ${type === value.type ? "selected" : ""}>${e(t(type === "text" ? "templates.typeText" : type === "number" ? "templates.typeNumber" : type === "boolean" ? "templates.typeBoolean" : "templates.typeChoice"))}</option>`).join("")}</select></label><label><input type="checkbox" data-field="required" ${value.required ? "checked" : ""}>${e(t("templates.required"))}</label><div data-parameter-type-fields>${parameterTypeFields(t, value)}</div><div class="styles-actions"><button type="button" class="wb-button" data-authoring-field-action="insert-parameter">${e(t("templates.insertPlaceholder"))}</button><button type="button" class="wb-button danger" data-authoring-field-action="remove-parameter">${e(t("templates.removeField"))}</button></div></fieldset>`;
}
export function readParameter(row: HTMLElement, prior?: TemplateParameter): TemplateParameter {
  const base = {
      id: fieldValue(row, "parameter-id"),
      label: readLocalized(row, "parameter-label", prior?.label),
      required: !!row.querySelector<HTMLInputElement>('[data-field="required"]')?.checked,
    },
    type = fieldValue(row, "parameter-type"),
    fallback = fieldValue(row, "default");
  if (type === "number")
    return {
      ...base,
      type,
      ...Object.fromEntries(
        ["default", "minimum", "maximum"]
          .filter((name) => fieldValue(row, name) !== "")
          .map((name) => [name, Number(fieldValue(row, name))]),
      ),
    };
  if (type === "boolean") return { ...base, type, ...(fallback ? { default: fallback === "true" } : {}) };
  if (type === "choice")
    return {
      ...base,
      type,
      options: [...row.querySelectorAll<HTMLElement>("[data-choice-index]")].map((option) => {
        const value = fieldValue(option, "choice-value"),
          previous = prior?.type === "choice" ? prior.options.find((item) => item.value === value) : undefined;
        return { value, label: readLocalized(option, "choice-label", previous?.label) };
      }),
      ...(fallback ? { default: fallback } : {}),
    };
  return {
    ...base,
    type: "text",
    ...(fallback ? { default: fallback } : {}),
    ...(fieldValue(row, "maxLength") ? { maxLength: Number(fieldValue(row, "maxLength")) } : {}),
  };
}
export function slotRow(t: Translate, value: DocumentTemplateDefinition["contentSlots"][number], index: number) {
  return `<fieldset class="template-slot-row" data-slot-index="${index}"><legend>${e(t("templates.contentSlot"))} ${index + 1}</legend>${templateField(t("templates.parameterId"), "slot-id", value.id, 'required maxlength="64"')}<label class="template-authoring-field"><span>${e(t("templates.contentType"))}</span><select data-field="slot-kind"><option value="rich-text" ${value.kind === "rich-text" ? "selected" : ""}>${e(t("templates.richText"))}</option><option value="plain-text" ${value.kind === "plain-text" ? "selected" : ""}>${e(t("templates.plainText"))}</option></select></label>${templateField(t("templates.defaultValue"), "slot-default", value.default, 'rows="3" maxlength="64000"', true)}<div class="styles-actions"><button type="button" class="wb-button" data-authoring-field-action="insert-slot">${e(t("templates.insertPlaceholder"))}</button><button type="button" class="wb-button danger" data-authoring-field-action="remove-slot">${e(t("templates.removeField"))}</button></div></fieldset>`;
}
