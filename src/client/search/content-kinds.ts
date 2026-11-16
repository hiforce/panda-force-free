import type { Translate } from "../../shared/i18n/messages.js";
import type { SearchSettings } from "../../shared/search/contracts.js";
import { searchContentKinds } from "../../shared/search/validation.js";
import { escapeHtml as e } from "../../shared/html.js";
import { SearchRequestError } from "./api.js";
import { searchChoice } from "./form-fields.js";

const kinds = ["document", "slides", "web"] as const;
export function searchContentKindsHtml(t: Translate) {
  return `<section role="group" aria-label="${e(t("search.contentKinds"))}"><h3>${e(t("search.contentKinds"))}</h3><p>${e(t("search.contentKindsHint"))}</p>${kinds.map((kind) => searchChoice(t, `creative.${kind}`, "kind-" + kind)).join("")}</section>`;
}
export function fillSearchContentKinds(form: HTMLFormElement, settings: SearchSettings) {
  const selected = searchContentKinds(settings.contentKinds);
  for (const kind of kinds)
    (form.elements.namedItem("pf-search-kind-" + kind) as HTMLInputElement).checked = selected.includes(kind);
}
/** Re-saving historical document-only settings does not add a new optional field or widen its rules. */
export function readSearchContentKinds(
  form: HTMLFormElement,
  previous: SearchSettings,
): Pick<SearchSettings, "contentKinds"> {
  const selected = kinds.filter(
    (kind) => (form.elements.namedItem("pf-search-kind-" + kind) as HTMLInputElement).checked,
  );
  if (!selected.length) throw new SearchRequestError("invalidInput");
  return previous.contentKinds === undefined && selected.length === 1 && selected[0] === "document"
    ? {}
    : { contentKinds: [...selected] };
}
