import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { KnowledgeRules, SearchSettings } from "../../shared/search/contracts.js";
import { setMessageHtml } from "../i18n.js";
import { searchChoice, searchField } from "./form-fields.js";

export interface SearchScopePreview {
  total: number;
  truncated: boolean;
  documents: { id: string; title: string; path: string; selected: boolean; kind?: "document" | "web" | "slides" }[];
}

export function searchIndexSelectionHtml(t: Translate) {
  return `${searchChoice(t, "search.indexFulltext", "fulltext", true)}${searchChoice(t, "search.indexVector", "vector")}
    <p>${e(t("search.vectorOptInHint"))}</p>
    <section data-knowledge-selection hidden class="search-knowledge-selection"><h3>${e(t("search.knowledgeRange"))}</h3><p>${e(t("search.knowledgeRangeHint"))}</p>
      ${searchField(t, "search.knowledgeRangeMode", `<select name="pf-search-knowledge-mode" class="wb-select"><option value="manual">${e(t("search.knowledgeManual"))}</option><option value="selected">${e(t("search.knowledgeSelected"))}</option><option value="project">${e(t("search.knowledgeProject"))}</option></select>`)}
      <p data-knowledge-selection-summary role="status"></p>
      <div class="resource-actions"><button class="wb-button" type="button" data-index-pick>${e(t("search.chooseKnowledgeSources"))}</button></div>
      <div data-knowledge-picker hidden>${searchField(t, "search.filterDocuments", '<input type="search" data-knowledge-filter maxlength="300">')}<p data-knowledge-picker-notice></p><ul class="search-scope-preview search-knowledge-picker" data-knowledge-choices></ul></div>
    </section>`;
}

/** Selection IDs stay intact when a preview is truncated or its sources are no longer listed. */
export function bindSearchIndexSelection(host: HTMLElement, t: Translate, changed: () => void) {
  const get = <T extends HTMLElement>(q: string) => host.querySelector<T>(q)!,
    mode = get<HTMLSelectElement>('[name="pf-search-knowledge-mode"]'),
    vector = get<HTMLInputElement>('[data-index-form] [name="pf-search-vector"]');
  let rules: KnowledgeRules = { mode: "manual", documents: [], subtrees: [], exclude: [] },
    preview: SearchScopePreview | null = null;
  const summary = () => {
    get("[data-knowledge-selection-summary]").textContent = t("search.knowledgeSelectionSummary", {
      documents: rules.documents.length,
      subtrees: rules.subtrees.length,
      exclusions: rules.exclude.length,
    });
    get("[data-knowledge-selection]").hidden = !vector.checked;
  };
  function render() {
    if (!preview) return;
    const query = get<HTMLInputElement>("[data-knowledge-filter]").value.toLocaleLowerCase(),
      matches = preview.documents.filter(
        (d) => (!d.kind || d.kind === "document") && (d.title + " " + d.path).toLocaleLowerCase().includes(query),
      ),
      shown = matches.slice(0, 50);
    get("[data-knowledge-picker-notice]").textContent =
      t("search.pickerCount", { shown: shown.length, total: matches.length }) +
      (preview.truncated ? " · " + t("search.previewLimited") : "");
    setMessageHtml(
      get("[data-knowledge-choices]"),
      shown
        .map(
          (d) =>
            `<li><strong data-i18n-ignore>${e(d.title)}</strong><span data-i18n-ignore>${e(d.path)}</span><div class="search-knowledge-options">${(
              ["documents", "subtrees", "exclude"] as const
            )
              .map((key) => {
                const label = t(
                  key === "documents"
                    ? "search.selectDocument"
                    : key === "subtrees"
                      ? "search.selectSubtree"
                      : "search.excludeSubtree",
                );
                return `<label class="wb-choice"><input type="checkbox" data-knowledge-rule="${key}" data-document-id="${e(d.id)}" aria-label="${e(label + ": " + d.title)}" ${rules[key].includes(d.id) ? "checked" : ""} ${key === "subtrees" && mode.value !== "selected" ? "disabled" : ""}><span>${e(label)}</span></label>`;
              })
              .join("")}</div></li>`,
        )
        .join(""),
    );
  }
  vector.addEventListener("change", summary);
  mode.onchange = () => {
    rules.mode = mode.value as KnowledgeRules["mode"];
    changed();
    render();
  };
  get<HTMLInputElement>("[data-knowledge-filter]").oninput = render;
  get("[data-knowledge-choices]").onchange = (event) => {
    const target = event.target as HTMLInputElement,
      key = target.dataset.knowledgeRule as "documents" | "subtrees" | "exclude" | undefined,
      id = target.dataset.documentId;
    if (!key || !id || !["documents", "subtrees", "exclude"].includes(key)) return;
    rules[key] = target.checked ? [...new Set([...rules[key], id])] : rules[key].filter((v) => v !== id);
    changed();
    summary();
  };
  return {
    fill(settings: SearchSettings) {
      for (const key of ["fulltext", "vector"] as const)
        get<HTMLInputElement>('[data-index-form] [name="pf-search-' + key + '"]').checked = settings[key];
      rules = structuredClone(settings.knowledge);
      mode.value = rules.mode;
      summary();
      render();
    },
    read() {
      return structuredClone(rules);
    },
    reset() {
      preview = null;
      get("[data-knowledge-picker]").hidden = true;
      get("[data-knowledge-choices]").replaceChildren();
      get<HTMLInputElement>("[data-knowledge-filter]").value = "";
    },
    show(result: SearchScopePreview) {
      preview = result;
      get("[data-knowledge-picker]").hidden = false;
      render();
    },
  };
}
