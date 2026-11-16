import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";

export const searchField = (t: Translate, key: MessageId, control: string) =>
  `<label class="resource-field wb-field"><span>${e(t(key))}</span>${control}</label>`;
export const searchInput = (name: string, type = "text", required = false) =>
  `<input name="pf-search-${name}" type="${type}" ${required ? "required" : ""} maxlength="2000" autocomplete="off">`;
export const searchValue = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem("pf-search-" + name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
export const searchChecked = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem("pf-search-" + name) as HTMLInputElement).checked;
export function searchChoice(t: Translate, key: MessageId, name: string, checked = false) {
  return `<label class="search-checkbox wb-choice"><input name="pf-search-${name}" type="checkbox" ${checked ? "checked" : ""}><span>${e(t(key))}</span></label>`;
}
