import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeReadDetail } from "../../shared/knowledge/catalog.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { setMessageHtml } from "../i18n.js";
import { KnowledgeApiError, knowledgeRequest } from "./api.js";
import { knowledgeDraftHtml } from "./draft-view.js";

/** Reading approved content has no task, model or editor lifetime. Closing always fences late replies. */
export class KnowledgeRecordView {
  private readonly dialog = document.createElement("dialog");
  private lifetime: AbortController | null = null;
  private previous: Element | null = null;
  constructor(
    private readonly t: Translate,
    private readonly dismissed: () => void,
  ) {
    this.dialog.className = "workbench-dialog knowledge-panel knowledge-record";
    document.body.append(this.dialog);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
      this.dismissed();
    });
    this.dialog.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target.closest("[data-knowledge-close]")) {
        this.close();
        this.dismissed();
      } else if (target.closest("a[data-wb=route]")) this.close();
    });
  }
  close() {
    const wasOpen = this.dialog.open;
    this.lifetime?.abort();
    this.lifetime = null;
    this.dialog.close();
    this.dialog.replaceChildren();
    if (wasOpen && this.previous instanceof HTMLElement && this.previous.isConnected)
      this.previous.focus({ preventScroll: true });
  }
  async open(project: string, id: string) {
    this.close();
    this.previous = document.activeElement;
    const lifetime = new AbortController(),
      { signal } = lifetime,
      t = this.t;
    this.lifetime = lifetime;
    this.dialog.setAttribute("aria-label", t("knowledge.recordTitle"));
    setMessageHtml(
      this.dialog,
      `<header class="knowledge-heading"><div><h2 data-knowledge-record-title data-i18n-ignore>${e(t("knowledge.recordTitle"))}</h2><p>${e(t("knowledge.recordHint"))}</p></div><button type="button" class="wb-button" data-knowledge-close aria-label="${e(t("knowledge.close"))}">${codexIcon("x")}</button></header><div class="knowledge-scroll" data-knowledge-record-body><p role="status">${e(t("knowledge.loading"))}</p></div>`,
    );
    this.dialog.showModal();
    const body = this.dialog.querySelector<HTMLElement>("[data-knowledge-record-body]")!;
    const read = async () => {
      setMessageHtml(body, `<p role="status">${e(t("knowledge.loading"))}</p>`);
      try {
        const { record, receipt } = await knowledgeRequest<KnowledgeReadDetail>(
          "/records/detail?" + new URLSearchParams({ project, id }),
          "GET",
          undefined,
          signal,
        );
        if (signal.aborted) return;
        this.dialog.querySelector<HTMLElement>("[data-knowledge-record-title]")!.textContent = record.draft.title;
        this.dialog.setAttribute("aria-label", record.draft.title);
        const sources = record.sources
          .map((source) => {
            const title = e(source.title),
              url = savedSourceUrl(project, source.id, source.binding?.kind, source.version);
            return `<li>${source.kind === "asset" ? `<a href="${e(url)}" data-wb="route" data-route="${e(url)}" data-i18n-ignore>${title}</a>` : `<span data-i18n-ignore>${title}</span>`}</li>`;
          })
          .join("");
        setMessageHtml(
          body,
          `<article class="knowledge-record-content">${knowledgeDraftHtml(record.draft, t, { title: false, sources: record.sources, compactEvidence: true })}<section class="knowledge-record-sources"><h3>${e(t("knowledge.sources"))}</h3><ul>${sources}</ul></section><details class="knowledge-record-history"><summary>${e(t("knowledge.recordProvenance"))}</summary><p>${e(new Date(record.approvedAt).toLocaleString())}</p><p><code>${e(receipt.version)}</code></p><p>Git · <code>${e(receipt.commit)}</code></p>${record.sources.map((source) => `<p data-i18n-ignore><b>${e(source.title)}</b><br><code>${e(source.version)}</code></p>`).join("")}</details></article>`,
        );
      } catch (error) {
        if (signal.aborted) return;
        const changed = error instanceof KnowledgeApiError && ["sourceChanged", "conflict"].includes(error.code);
        setMessageHtml(
          body,
          `<p role="status">${e(t(changed ? "knowledge.recordChanged" : "knowledge.recordUnavailable"))}</p><button type="button" class="wb-button" data-knowledge-record-retry>${e(t("knowledge.retry"))}</button>`,
        );
        body.querySelector<HTMLButtonElement>("[data-knowledge-record-retry]")!.onclick = () => void read();
      }
    };
    await read();
  }
}
import { savedSourceUrl } from "../../shared/content-sources/links.js";
