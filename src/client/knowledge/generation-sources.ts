import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeGenerationSourcePage, KnowledgeGenerationSelection } from "../../shared/knowledge/generation.js";
import { GENERATION_LIMITS } from "../../shared/knowledge/generation.js";
import { setMessageHtml } from "../i18n.js";
import { knowledgeRequest, KnowledgeApiError } from "./api.js";
import { knowledgeRuleSourcesHtml } from "./generation-view.js";

/** Page changes preserve all rule IDs, including selected sources outside the visible page. */
export class KnowledgeGenerationSources {
  private selection: KnowledgeGenerationSelection = {
    all: false,
    documents: [],
    subtrees: [],
    excludeDocuments: [],
    excludeSubtrees: [],
  };
  private page: KnowledgeGenerationSourcePage | null = null;
  private offset = 0;
  private read: AbortController | null = null;
  private sequence = 0;
  private busy = false;
  constructor(
    private host: HTMLElement,
    private project: string,
    private t: Translate,
    private signal: AbortSignal,
    private changed: () => void,
  ) {
    this.get("[data-rule-sources]").onchange = (event) => {
      const input = event.target as HTMLSelectElement,
        id = input.dataset.ruleId;
      if (!id || !this.page?.documents.some((d) => d.id === id)) return;
      const keys =
        input.dataset.ruleSource === "exclude"
          ? (["excludeDocuments", "excludeSubtrees"] as const)
          : (["documents", "subtrees"] as const);
      const target = input.value === "tree" ? keys[1] : keys[0];
      if (
        input.value !== "none" &&
        !this.selection[target].includes(id) &&
        this.selection[target].length >= GENERATION_LIMITS.selection
      ) {
        this.get("[data-rule-page-notice]").textContent = this.t("knowledge.rulesBudget");
        this.render();
        return;
      }
      for (const key of keys) this.selection[key] = this.selection[key].filter((v) => v !== id);
      if (input.value !== "none") this.selection[target].push(id);
      this.summary();
      this.changed();
    };
    this.get<HTMLButtonElement>("[data-rule-previous]").onclick = () => void this.load(Math.max(0, this.offset - 50));
    this.get<HTMLButtonElement>("[data-rule-next]").onclick = () => {
      if (this.page?.next !== null && this.page?.next !== undefined) void this.load(this.page.next);
    };
    this.get<HTMLButtonElement>("[data-rule-sources-reload]").onclick = () => void this.load(0, true);
    this.get<HTMLButtonElement>("[data-rule-clear]").onclick = () => {
      this.selection = { ...this.selection, documents: [], subtrees: [], excludeDocuments: [], excludeSubtrees: [] };
      this.render();
      this.changed();
    };
    this.get<HTMLDetailsElement>("[data-rule-picker]").ontoggle = () => {
      if (this.get<HTMLDetailsElement>("[data-rule-picker]").open && !this.page && !this.busy) void this.load();
    };
  }
  get loaded() {
    return this.page !== null;
  }
  private get<T extends HTMLElement = HTMLElement>(q: string) {
    return this.host.querySelector<T>(q)!;
  }
  fill(selection: KnowledgeGenerationSelection) {
    const { originals: _originals, ...documents } = selection;
    this.selection = structuredClone(documents);
    this.render();
  }
  value(all: boolean) {
    return { ...structuredClone(this.selection), all };
  }
  private summary() {
    this.get("[data-rule-summary]").textContent = this.t("knowledge.rulesSelectionSummary", {
      documents: this.selection.documents.length,
      subtrees: this.selection.subtrees.length,
      exclusions: this.selection.excludeDocuments.length + this.selection.excludeSubtrees.length,
    });
  }
  private render() {
    this.summary();
    if (this.page)
      setMessageHtml(this.get("[data-rule-sources]"), knowledgeRuleSourcesHtml(this.page, this.selection, this.t));
    this.get<HTMLButtonElement>("[data-rule-previous]").disabled = this.busy || !this.page || this.offset === 0;
    this.get<HTMLButtonElement>("[data-rule-next]").disabled = this.busy || !this.page || this.page.next === null;
    for (const control of this.get("[data-rule-sources]").querySelectorAll<HTMLSelectElement>("select"))
      control.disabled = this.busy;
  }
  async load(offset = 0, restart = false) {
    this.read?.abort();
    const read = new AbortController(),
      sequence = ++this.sequence;
    this.read = read;
    this.busy = true;
    this.render();
    this.get("[data-rule-page-notice]").textContent = this.t("knowledge.loading");
    try {
      const page = await knowledgeRequest<KnowledgeGenerationSourcePage>(
        "/generation-sources",
        "POST",
        { project: this.project, offset, ...(!restart && this.page ? { commit: this.page.commit } : {}) },
        AbortSignal.any([this.signal, read.signal]),
      );
      if (this.signal.aborted || sequence !== this.sequence) return;
      this.page = page;
      this.offset = offset;
      this.get("[data-rule-page-notice]").textContent = this.t("knowledge.rulesPage", {
        shown: page.documents.length,
        total: page.total,
      });
    } catch (error) {
      if (!this.signal.aborted && !read.signal.aborted)
        this.get("[data-rule-page-notice]").textContent = this.t(
          error instanceof KnowledgeApiError && error.code === "conflict"
            ? "knowledge.rulesSourcesChanged"
            : "knowledge.unavailable",
        );
    } finally {
      if (!this.signal.aborted && sequence === this.sequence) {
        this.busy = false;
        this.render();
      }
    }
  }
}
