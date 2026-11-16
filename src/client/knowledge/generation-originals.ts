import type { Translate } from "../../shared/i18n/messages.js";
import type { SavedSourcePage, SavedSourceSummary } from "../../shared/content-sources/catalog.js";
import type {
  KnowledgeGenerationOriginals,
  GenerationOriginalKind,
} from "../../shared/knowledge/generation-originals.js";
import { GENERATION_LIMITS } from "../../shared/knowledge/generation.js";
import { documentJson, DocumentApiError } from "../documents/api.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import { knowledgeOriginalRows } from "./generation-original-view.js";

/** Native overrides remain flat, explicit and separate from document ancestry; reads use the shared metadata-only catalog. */
export class KnowledgeGenerationOriginalSources {
  private overrides = { ids: [] as string[], exclude: [] as string[] };
  private rows: SavedSourceSummary[] = [];
  private head: string | undefined;
  private offset = 0;
  private next: number | null = null;
  private busy = false;
  private sequence = 0;
  private read: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private host: HTMLElement,
    private project: string,
    private t: Translate,
    private signal: AbortSignal,
    private changed: () => void,
  ) {
    const section = this.get("[data-rule-native]");
    section.oninput = (event) => event.stopPropagation();
    section.onchange = (event) => {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (input.matches("[data-native-enable],[data-native-kind]")) {
        this.read?.abort();
        this.sequence++;
        this.rows = [];
        this.head = undefined;
        this.offset = 0;
        this.next = null;
        this.scope();
        this.changed();
        if (this.canBrowse) void this.load();
      } else if (input.matches("[data-native-all]")) this.changed();
      else if (input.matches("[data-native-browse]")) {
        this.head = undefined;
        void this.load();
      } else if (input.dataset.nativeChoice && !this.busy) {
        const id = input.dataset.nativeChoice,
          target = input.value === "include" ? "ids" : "exclude";
        if (
          input.value !== "default" &&
          !this.overrides[target].includes(id) &&
          this.overrides[target].length >= GENERATION_LIMITS.selection
        ) {
          this.notice(t("knowledge.rulesBudget"));
          this.render();
          return;
        }
        this.overrides.ids = this.overrides.ids.filter((value) => value !== id);
        this.overrides.exclude = this.overrides.exclude.filter((value) => value !== id);
        if (input.value !== "default") this.overrides[target].push(id);
        this.render();
        this.changed();
      }
    };
    this.get<HTMLInputElement>("[data-native-search]").oninput = (event) => {
      event.stopPropagation();
      this.read?.abort();
      this.sequence++;
      clearTimeout(this.timer);
      this.head = undefined;
      this.busy = true;
      this.render();
      this.timer = setTimeout(() => void this.load(), 200);
    };
    this.get<HTMLDetailsElement>("[data-native-picker]").ontoggle = () => {
      if (this.canBrowse && !this.rows.length && !this.busy) void this.load();
    };
    this.get("[data-native-reload]").onclick = () => {
      this.head = undefined;
      void this.load();
    };
    this.get("[data-native-clear]").onclick = () => {
      this.overrides = { ids: [], exclude: [] };
      this.render();
      this.changed();
    };
    this.get("[data-native-previous]").onclick = () => void this.load(Math.max(0, this.offset - 100));
    this.get("[data-native-next]").onclick = () => {
      if (this.next !== null) void this.load(this.next);
    };
    signal.addEventListener(
      "abort",
      () => {
        this.read?.abort();
        clearTimeout(this.timer);
      },
      { once: true },
    );
  }
  private get<T extends HTMLElement = HTMLElement>(query: string) {
    return this.host.querySelector<T>(query)!;
  }
  private get kinds(): GenerationOriginalKind[] {
    return ["slides", "web"].filter(
      (kind) => this.get<HTMLInputElement>(`[data-native-kind][value="${kind}"]`).checked,
    ) as GenerationOriginalKind[];
  }
  private get canBrowse() {
    return (
      this.get<HTMLInputElement>("[data-native-enable]").checked &&
      !!this.kinds.length &&
      this.get<HTMLDetailsElement>("[data-native-picker]").open
    );
  }
  value(): KnowledgeGenerationOriginals | undefined {
    return this.get<HTMLInputElement>("[data-native-enable]").checked
      ? {
          contentKinds: this.kinds,
          all: this.get<HTMLInputElement>("[data-native-all]").checked,
          ids: [...this.overrides.ids],
          exclude: [...this.overrides.exclude],
        }
      : undefined;
  }
  fill(rule?: KnowledgeGenerationOriginals) {
    this.read?.abort();
    this.sequence++;
    this.busy = false;
    clearTimeout(this.timer);
    this.get<HTMLInputElement>("[data-native-enable]").checked = !!rule;
    for (const input of this.host.querySelectorAll<HTMLInputElement>("[data-native-kind]"))
      input.checked = !!rule?.contentKinds.includes(input.value as GenerationOriginalKind);
    this.get<HTMLInputElement>("[data-native-all]").checked = rule?.all ?? false;
    this.overrides = { ids: [...(rule?.ids ?? [])], exclude: [...(rule?.exclude ?? [])] };
    this.rows = [];
    this.head = undefined;
    this.offset = 0;
    this.next = null;
    this.scope();
    if (this.canBrowse) void this.load();
  }
  private scope() {
    const enabled = this.get<HTMLInputElement>("[data-native-enable]").checked,
      field = this.get<HTMLFieldSetElement>("[data-native-scope]"),
      browse = this.get<HTMLSelectElement>("[data-native-browse]"),
      prior = browse.value;
    field.hidden = !enabled;
    field.disabled = !enabled;
    setMessageHtml(
      browse,
      this.kinds
        .map(
          (kind) =>
            `<option value="${kind}">${e(this.t(kind === "web" ? "creative.web" : "creative.slides"))}</option>`,
        )
        .join(""),
    );
    if (this.kinds.includes(prior as GenerationOriginalKind)) browse.value = prior;
    this.busy = false;
    this.render();
    this.notice(this.kinds.length ? "" : this.t("knowledge.rulesOriginalsChooseTypes"));
  }
  private notice(text: string) {
    if (!this.signal.aborted) this.get("[data-native-notice]").textContent = text;
  }
  private render() {
    setMessageHtml(this.get("[data-native-sources]"), knowledgeOriginalRows(this.rows, this.overrides, this.t));
    this.get("[data-native-summary]").textContent = this.t("knowledge.rulesOriginalsSummary", {
      included: this.overrides.ids.length,
      excluded: this.overrides.exclude.length,
    });
    for (const input of this.host.querySelectorAll<HTMLSelectElement>("[data-native-choice]"))
      input.disabled = this.busy;
    this.get<HTMLButtonElement>("[data-native-previous]").disabled = this.busy || !this.offset;
    this.get<HTMLButtonElement>("[data-native-next]").disabled = this.busy || this.next === null;
    for (const name of ["previous", "next"])
      this.get<HTMLButtonElement>(`[data-native-${name}]`).hidden = !this.offset && this.next === null;
  }
  async load(offset = 0) {
    if (!this.canBrowse || this.signal.aborted) return;
    this.read?.abort();
    clearTimeout(this.timer);
    const read = new AbortController(),
      sequence = ++this.sequence;
    this.read = read;
    this.busy = true;
    this.render();
    this.notice(this.t("knowledge.loading"));
    try {
      const page = await documentJson<SavedSourcePage>(
        "/api/content-sources?" +
          new URLSearchParams({
            project: this.project,
            contentKinds: this.get<HTMLSelectElement>("[data-native-browse]").value,
            search: this.get<HTMLInputElement>("[data-native-search]").value,
            offset: String(offset),
            ...(this.head ? { head: this.head } : {}),
          }),
        "GET",
        undefined,
        AbortSignal.any([this.signal, read.signal, AbortSignal.timeout(30000)]),
      );
      if (this.signal.aborted || read.signal.aborted || sequence !== this.sequence) return;
      this.rows = page.sources;
      this.head = page.head;
      this.offset = offset;
      this.next = page.nextOffset;
      this.get("[data-native-page]").textContent = this.t("knowledge.sourcePage", {
        start: page.total ? offset + 1 : 0,
        end: offset + page.sources.length,
        total: page.total,
      });
      this.notice(page.sources.length ? "" : this.t("knowledge.sourceEmpty"));
    } catch (error) {
      if (!this.signal.aborted && !read.signal.aborted && sequence === this.sequence) {
        this.rows = [];
        this.next = null;
        this.notice(
          this.t(
            error instanceof DocumentApiError && error.status === 409
              ? "knowledge.rulesSourcesChanged"
              : "knowledge.sourceUnavailable",
          ),
        );
      }
    } finally {
      if (!this.signal.aborted && sequence === this.sequence) {
        this.busy = false;
        this.render();
      }
    }
  }
}
