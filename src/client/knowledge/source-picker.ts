import type { Translate } from "../../shared/i18n/messages.js";
import type { SavedSourceKind } from "../../shared/content-sources/contracts.js";
import type { SavedSourcePage } from "../../shared/content-sources/catalog.js";
import { SAVED_SOURCE_KINDS } from "../../shared/content-sources/selection.js";
import { documentJson, DocumentApiError } from "../documents/api.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { KnowledgePanelContext, KnowledgeSourceChoice } from "./source-types.js";
import type { KnowledgePendingSubmission } from "./submission.js";
import { knowledgeSourcesHtml, sourceKindMessage } from "./source-view.js";

/** Selection survives filters and pages; only read-only metadata is loaded and late requests cannot replace a newer page. */
export class KnowledgeSourcePicker {
  private readonly selected = new Map<
    string,
    Pick<KnowledgeSourceChoice, "id" | "title"> & Partial<Pick<KnowledgeSourceChoice, "kind">>
  >();
  private rows: KnowledgeSourceChoice[] = [];
  private offset = 0;
  private next: number | null = null;
  private head: string | undefined;
  private query = "";
  private kind: SavedSourceKind = "document";
  private disabled = true;
  private busy = false;
  private loaded = false;
  private sequence = 0;
  private read: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly host: HTMLElement,
    private readonly context: KnowledgePanelContext,
    private readonly t: Translate,
    private readonly signal: AbortSignal,
    pending: KnowledgePendingSubmission | null,
    private readonly changed: () => void,
  ) {
    const known: KnowledgeSourceChoice[] = [
      ...(context.documents ?? []).map((row) => ({ ...row, kind: "document" as const })),
      ...(context.sources ?? []),
    ];
    const initial = pending?.ids ?? context.selected;
    for (const id of initial) this.selected.set(id, known.find((row) => row.id === id) ?? { id, title: id });
    this.kind = this.selected.values().next().value?.kind ?? pending?.contentKinds?.[0] ?? "document";
    this.get<HTMLSelectElement>("[data-source-kind]").value = this.kind;
    this.rows = known.filter((row) => row.kind === this.kind).slice(0, 100);
    this.get<HTMLSelectElement>("[data-source-kind]").onchange = (event) => {
      this.kind = (event.target as HTMLSelectElement).value as SavedSourceKind;
      this.head = undefined;
      this.rows = [];
      void this.load(0);
    };
    this.get<HTMLInputElement>("[data-knowledge-filter]").oninput = (event) => {
      this.query = (event.target as HTMLInputElement).value;
      this.head = undefined;
      this.read?.abort();
      this.sequence++;
      this.loaded = false;
      this.busy = true;
      this.controls();
      this.changed();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.load(0), 200);
    };
    this.get("[data-knowledge-sources]").onchange = (event) => {
      const input = event.target as HTMLInputElement,
        row = this.rows.find((row) => row.id === input.value);
      if (!row || this.disabled || this.busy) return;
      if (!input.checked) this.selected.delete(row.id);
      else if (this.selected.size < 32) this.selected.set(row.id, { ...row });
      else this.notice(t("knowledge.selectionLimit"));
      this.render();
      this.changed();
    };
    this.get("[data-source-selected-list]").onclick = (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-source-remove]");
      if (!button || this.disabled || this.busy) return;
      this.selected.delete(button.dataset.sourceRemove!);
      this.render();
      this.changed();
    };
    this.get("[data-source-clear]").onclick = () => {
      if (this.disabled || this.busy) return;
      this.selected.clear();
      this.render();
      this.changed();
    };
    this.get("[data-source-reload]").onclick = () => {
      this.head = undefined;
      void this.load(0);
    };
    this.get("[data-source-previous]").onclick = () => void this.load(Math.max(0, this.offset - 100));
    this.get("[data-source-next]").onclick = () => {
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
    this.render();
  }
  get ready() {
    return this.loaded && !this.busy;
  }
  get selection() {
    const values = [...this.selected.values()],
      kinds = SAVED_SOURCE_KINDS.filter((kind) => values.some((row) => row.kind === kind));
    return {
      ids: values.map((row) => row.id).sort(),
      ...(kinds.some((kind) => kind !== "document") ? { contentKinds: kinds } : {}),
    };
  }
  setDisabled(value: boolean) {
    this.disabled = value;
    this.controls();
  }
  private get<T extends HTMLElement = HTMLElement>(selector: string) {
    return this.host.querySelector<T>(selector)!;
  }
  private notice(text: string) {
    if (!this.signal.aborted) this.get("[data-source-notice]").textContent = text;
  }
  private controls() {
    this.get<HTMLFieldSetElement>("[data-source-fields]").disabled = this.disabled;
    for (const input of this.get("[data-knowledge-sources]").querySelectorAll<HTMLInputElement>("input"))
      input.disabled = this.busy;
    this.get<HTMLButtonElement>("[data-source-previous]").disabled = this.busy || !this.loaded || this.offset === 0;
    this.get<HTMLButtonElement>("[data-source-next]").disabled = this.busy || !this.loaded || this.next === null;
    this.get<HTMLButtonElement>("[data-source-clear]").disabled = this.busy || !this.selected.size;
    const paged = this.offset > 0 || this.next !== null;
    this.get<HTMLButtonElement>("[data-source-previous]").hidden = !paged;
    this.get<HTMLButtonElement>("[data-source-next]").hidden = !paged;
  }
  private render() {
    setMessageHtml(
      this.get("[data-knowledge-sources]"),
      this.rows.length
        ? knowledgeSourcesHtml(this.rows, new Set(this.selected.keys()), this.t)
        : `<p>${e(this.t(this.busy ? "knowledge.loading" : "knowledge.sourceEmpty"))}</p>`,
    );
    this.get("[data-source-summary]").textContent = this.t("knowledge.sourceSelected", { count: this.selected.size });
    this.get("[data-source-selected]").hidden = !this.selected.size;
    setMessageHtml(
      this.get("[data-source-selected-list]"),
      [...this.selected.values()]
        .map(
          (row) =>
            `<div class="knowledge-selected-source"><span data-i18n-ignore>${e(row.title)}</span>${row.kind ? `<small>${e(this.t(sourceKindMessage[row.kind]))}</small>` : ""}<button type="button" class="wb-button" data-source-remove="${e(row.id)}" aria-label="${e(this.t("knowledge.sourceRemove", { title: row.title }))}">×</button></div>`,
        )
        .join(""),
    );
    this.controls();
  }
  async load(offset = 0) {
    this.read?.abort();
    clearTimeout(this.timer);
    const sequence = ++this.sequence,
      read = new AbortController();
    this.read = read;
    this.busy = true;
    this.loaded = false;
    this.controls();
    this.changed();
    this.notice(this.t("knowledge.loading"));
    const kind = this.kind,
      query = this.query;
    try {
      const page = await documentJson<SavedSourcePage>(
        "/api/content-sources?" +
          new URLSearchParams({
            project: this.context.project,
            contentKinds: kind,
            search: query,
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
      this.loaded = true;
      for (const row of this.rows)
        if (this.selected.has(row.id)) this.selected.set(row.id, { id: row.id, title: row.title, kind: row.kind });
      this.get("[data-source-page]").textContent = this.t("knowledge.sourcePage", {
        start: page.total ? offset + 1 : 0,
        end: offset + page.sources.length,
        total: page.total,
      });
      this.notice("");
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
        this.changed();
      }
    }
  }
}
