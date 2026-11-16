import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgeReviewPolicy } from "../../shared/knowledge/review.js";
import { knowledgeApi, knowledgeRequest } from "./api.js";

export class KnowledgeReviewPreference {
  private value: KnowledgeReviewPolicy = { automatic: false, revision: 0 };
  constructor(
    private readonly host: HTMLElement,
    private readonly project: string,
    private readonly t: Translate,
    private readonly signal: AbortSignal,
    private readonly changed: () => void,
    private readonly error: (error: unknown) => void,
  ) {}
  get automatic() {
    return this.value.automatic;
  }
  async load() {
    const { policy } = await knowledgeApi.policy(this.project, this.signal);
    if (this.signal.aborted) return;
    this.value = policy;
    const toggle = this.host.querySelector<HTMLInputElement>("[data-knowledge-automatic]")!;
    const render = () => {
      toggle.checked = this.value.automatic;
      this.host.querySelector<HTMLElement>("[data-knowledge-policy-hint]")!.textContent = this.t(
        this.value.automatic ? "knowledge.automaticHint" : "knowledge.manualHint",
      );
    };
    render();
    toggle.disabled = false;
    toggle.onchange = async () => {
      toggle.disabled = true;
      try {
        const { policy } = await knowledgeRequest<{ policy: KnowledgeReviewPolicy }>(
          "/review-policy",
          "PUT",
          { project: this.project, automatic: toggle.checked, revision: this.value.revision },
          this.signal,
        );
        if (this.signal.aborted) return;
        this.value = policy;
        render();
        this.changed();
      } catch (error) {
        if (!this.signal.aborted) {
          try {
            this.value = (await knowledgeApi.policy(this.project, this.signal)).policy;
          } catch {
            /* Keep the last confirmed preference. */
          }
          if (!this.signal.aborted) {
            render();
            this.error(error);
          }
        }
      } finally {
        if (!this.signal.aborted) toggle.disabled = false;
      }
    };
  }
}
