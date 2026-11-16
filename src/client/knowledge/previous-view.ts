import type { KnowledgePreviousSummary } from "../../shared/knowledge/tasks.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { knowledgeRequest, KnowledgeApiError } from "./api.js";

export function knowledgePreviousHtml(previous: KnowledgePreviousSummary | undefined, t: Translate) {
  if (!previous) return "";
  return `<section class="knowledge-previous wb-form" data-knowledge-previous>${previous.reviewRequired ? `<p>${e(t("knowledge.previousHint"))}</p>` : ""}<details><summary>${e(t("knowledge.previousCompare"))}</summary><div data-knowledge-previous-content role="region" aria-label="${e(t("knowledge.previousTitle"))}"></div></details>${previous.reviewRequired ? `<label class="wb-choice"><input type="checkbox" data-knowledge-previous-ack disabled><span>${e(t("knowledge.previousConfirm"))}</span></label>` : ""}</section>`;
}
/** Saved text loads on disclosure, never on metadata polling; acknowledgement belongs to one task and target state. */
export class KnowledgePreviousView {
  private ready = false;
  private loading = false;
  constructor(
    private host: HTMLElement,
    private id: string,
    private previous: KnowledgePreviousSummary,
    private t: Translate,
    private signal: AbortSignal,
    private changed: () => void,
  ) {
    const details = host.querySelector("details")!;
    details.ontoggle = () => {
      if (details.open) void this.load();
    };
    const checkbox = host.querySelector<HTMLInputElement>("[data-knowledge-previous-ack]");
    if (checkbox) checkbox.onchange = changed;
  }
  get acknowledgement() {
    return this.ready && this.host.querySelector<HTMLInputElement>("[data-knowledge-previous-ack]")?.checked
      ? this.previous.state
      : undefined;
  }
  lock(busy: boolean) {
    const checkbox = this.host.querySelector<HTMLInputElement>("[data-knowledge-previous-ack]");
    if (checkbox) checkbox.disabled = busy || !this.ready;
  }
  private async load() {
    if (this.ready || this.loading || this.signal.aborted) return;
    this.loading = true;
    const target = this.host.querySelector<HTMLElement>("[data-knowledge-previous-content]")!;
    target.textContent = this.t("knowledge.loading");
    try {
      const parts: string[] = [];
      let offset = 0,
        title = "",
        complete = false;
      for (let page = 0; page < 32; page++) {
        const { previous } = await knowledgeRequest<{
          previous: KnowledgePreviousSummary & { markdown: string; start: number; next: number | null; total: number };
        }>(
          "/tasks/previous?" + new URLSearchParams({ id: this.id, offset: String(offset) }),
          "GET",
          undefined,
          this.signal,
        );
        if (this.signal.aborted || !this.host.isConnected) return;
        if (
          previous.state !== this.previous.state ||
          previous.start !== offset ||
          typeof previous.markdown !== "string" ||
          previous.total > 1024 * 1024 ||
          previous.markdown.length > 65536
        )
          throw new KnowledgeApiError("conflict");
        parts.push(previous.markdown);
        title = previous.title;
        const end = offset + previous.markdown.length;
        if (previous.next === null) {
          if (end !== previous.total) throw new KnowledgeApiError("conflict");
          complete = true;
          break;
        }
        if (previous.next !== end || end <= offset) throw new KnowledgeApiError("conflict");
        offset = end;
      }
      if (!complete) throw new KnowledgeApiError("unavailable");
      setMessageHtml(target, `<h4 data-i18n-ignore>${e(title)}</h4><pre data-i18n-ignore>${e(parts.join(""))}</pre>`);
      this.ready = true;
      this.changed();
    } catch {
      if (!this.signal.aborted && this.host.isConnected) {
        setMessageHtml(
          target,
          `<p role="alert">${e(this.t("knowledge.previousFailed"))}</p><button class="wb-button" type="button">${e(this.t("knowledge.retry"))}</button>`,
        );
        target.querySelector<HTMLButtonElement>("button")!.onclick = () => void this.load();
      }
    } finally {
      this.loading = false;
    }
  }
}
