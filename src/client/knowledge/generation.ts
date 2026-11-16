import { KnowledgeGenerationOriginalSources } from "./generation-originals.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type {
  KnowledgeGenerationPolicy,
  KnowledgeGenerationChange,
  KnowledgeGenerationStatus,
} from "../../shared/knowledge/generation.js";
import { defaultGenerationPolicy, generationChange } from "../../shared/knowledge/generation.js";
import { setMessageHtml } from "../i18n.js";
import { knowledgeRequest, knowledgeApi, KnowledgeApiError } from "./api.js";
import { knowledgeGenerationHtml, knowledgeRuleStatusHtml } from "./generation-view.js";
import { KnowledgeGenerationSources } from "./generation-sources.js";

/** Generation configuration is loaded on demand and never changes the independent review preference. */
export class KnowledgeGenerationView {
  private policy = defaultGenerationPolicy();
  private initialized = false;
  private loaded = false;
  private busy = false;
  private uncertain = false;
  private available = false;
  private change = 0;
  private previewed = -1;
  private previewCommit: string | undefined;
  private preview: AbortController | null = null;
  private sources: KnowledgeGenerationSources | null = null;
  private originals: KnowledgeGenerationOriginalSources | null = null;
  private statusRead: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  constructor(
    private host: HTMLElement,
    private project: string,
    private t: Translate,
    private signal: AbortSignal,
    private changed: () => void,
  ) {
    signal.addEventListener("abort", () => clearTimeout(this.timer), { once: true });
  }
  hide() {
    this.active = false;
    clearTimeout(this.timer);
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.active || this.signal.aborted) return;
    this.timer = setTimeout(
      () => {
        void this.refresh().finally(() => this.schedule());
      },
      document.visibilityState === "hidden" ? 30000 : 10000,
    );
  }
  private get<T extends HTMLElement = HTMLElement>(q: string) {
    return this.host.querySelector<T>(q)!;
  }
  private field<T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement>(name: string) {
    return this.get<T>('[name="pf-knowledge-rule-' + name + '"]');
  }
  private controls() {
    this.get<HTMLFieldSetElement>("[data-rule-fields]").disabled = this.busy || !this.loaded;
    this.get<HTMLButtonElement>("[data-rule-apply]").disabled =
      this.busy ||
      !this.loaded ||
      this.uncertain ||
      (this.field("enabled").checked && (!this.available || this.previewed !== this.change));
    this.get<HTMLButtonElement>("[data-rule-reload]").disabled = this.busy;
    this.field<HTMLTextAreaElement>("purpose").required = this.field("enabled").checked;
  }
  private notice(text: string) {
    if (!this.signal.aborted) this.get("[data-rule-notice]").textContent = text;
  }
  private dirty = () => {
    this.change++;
    this.previewed = -1;
    this.previewCommit = undefined;
    this.preview?.abort();
    this.get("[data-rule-preview-notice]").textContent = this.t("knowledge.rulesPreviewHint");
    this.controls();
  };
  private input(): KnowledgeGenerationChange {
    return generationChange({
      ...this.policy,
      enabled: this.field("enabled").checked,
      purpose: this.field<HTMLTextAreaElement>("purpose").value,
      selection: {
        ...this.sources!.value(this.field("all").checked),
        ...(this.originals!.value() ? { originals: this.originals!.value() } : {}),
      },
      dailyLimit: this.field("daily").valueAsNumber,
      pendingLimit: this.field("pending").valueAsNumber,
      backfill: this.field("backfill").checked,
    });
  }
  private fill(policy: KnowledgeGenerationPolicy) {
    this.policy = policy;
    this.field("enabled").checked = policy.enabled;
    this.field<HTMLTextAreaElement>("purpose").value = policy.purpose;
    this.field("all").checked = policy.selection.all;
    this.field("daily").value = String(policy.dailyLimit);
    this.field("pending").value = String(policy.pendingLimit);
    this.field("backfill").checked = false;
    this.sources!.fill(policy.selection);
    this.originals!.fill(policy.selection.originals);
    this.change++;
    this.previewed = -1;
    this.previewCommit = undefined;
    this.uncertain = false;
    this.get("[data-rule-preview-notice]").textContent = this.t("knowledge.rulesPreviewHint");
  }
  async open() {
    this.active = true;
    if (this.initialized) {
      if (this.loaded) void this.refresh();
      this.schedule();
      return;
    }
    this.initialized = true;
    setMessageHtml(this.host, knowledgeGenerationHtml(this.t));
    this.sources = new KnowledgeGenerationSources(this.host, this.project, this.t, this.signal, this.dirty);
    this.originals = new KnowledgeGenerationOriginalSources(this.host, this.project, this.t, this.signal, this.dirty);
    const form = this.get<HTMLFormElement>("[data-rule-form]");
    form.oninput = this.dirty;
    this.get<HTMLButtonElement>("[data-rule-preview]").onclick = () => void this.scopePreview();
    this.get<HTMLButtonElement>("[data-rule-reload]").onclick = () => void this.load();
    this.get<HTMLButtonElement>("[data-rule-status-refresh]").onclick = () => void this.refresh();
    form.onsubmit = (event) => {
      event.preventDefault();
      void this.save();
    };
    await this.load();
    this.schedule();
  }
  private async load() {
    if (this.busy) return;
    this.busy = true;
    this.controls();
    this.preview?.abort();
    this.notice(this.t("knowledge.loading"));
    try {
      const [{ policy }, options] = await Promise.all([
        knowledgeRequest<{ policy: KnowledgeGenerationPolicy }>(
          "/generation-policy?" + new URLSearchParams({ project: this.project }),
          "GET",
          undefined,
          this.signal,
        ),
        knowledgeApi.options(this.signal),
      ]);
      if (this.signal.aborted) return;
      this.available = options.available;
      this.get("[data-rule-availability]").hidden = this.available;
      this.fill(policy);
      this.loaded = true;
      this.notice("");
    } catch (error) {
      if (!this.signal.aborted) this.report(error);
    } finally {
      if (!this.signal.aborted) {
        this.busy = false;
        this.controls();
      }
    }
    if (this.loaded && !this.signal.aborted)
      await Promise.all([this.sources!.loaded ? this.sources!.load(0, true) : Promise.resolve(), this.refresh()]);
  }
  private report(error: unknown) {
    this.notice(
      this.t(
        error instanceof KnowledgeApiError && error.code === "conflict"
          ? "knowledge.rulesSaveUnknown"
          : error instanceof KnowledgeApiError && error.code === "budget"
            ? "knowledge.rulesBudget"
            : "knowledge.unavailable",
      ),
    );
  }
  private async scopePreview() {
    if (this.busy || !this.loaded || !this.get<HTMLFormElement>("[data-rule-form]").reportValidity()) return;
    let input: KnowledgeGenerationChange;
    try {
      input = this.input();
    } catch {
      this.notice(this.t("knowledge.invalidInput"));
      return;
    }
    this.preview?.abort();
    const read = new AbortController(),
      change = this.change;
    this.preview = read;
    this.get("[data-rule-preview-notice]").textContent = this.t("knowledge.loading");
    try {
      const result = await knowledgeRequest<{ count: number; commit: string }>(
        "/generation-preview",
        "POST",
        { project: this.project, policy: input },
        AbortSignal.any([this.signal, read.signal]),
      );
      if (this.signal.aborted || read.signal.aborted || change !== this.change) return;
      this.previewed = change;
      this.previewCommit = result.commit;
      this.get("[data-rule-preview-notice]").textContent = this.t("knowledge.rulesPreviewResult", {
        count: result.count,
      });
      this.notice("");
      this.controls();
    } catch (error) {
      if (!this.signal.aborted && !read.signal.aborted) this.report(error);
    }
  }
  private async save() {
    if (
      this.busy ||
      !this.loaded ||
      this.uncertain ||
      (this.field("enabled").checked && (!this.available || this.previewed !== this.change))
    )
      return;
    let input: KnowledgeGenerationChange;
    try {
      input = this.input();
    } catch {
      this.notice(this.t("knowledge.invalidInput"));
      return;
    }
    this.busy = true;
    this.preview?.abort();
    this.controls();
    try {
      const { policy } = await knowledgeRequest<{ policy: KnowledgeGenerationPolicy }>(
        "/generation-policy",
        "PUT",
        { project: this.project, policy: input, ...(input.enabled ? { sourceCommit: this.previewCommit } : {}) },
        this.signal,
      );
      if (this.signal.aborted) return;
      this.fill(policy);
      this.notice(this.t("knowledge.rulesSaved"));
      this.changed();
    } catch {
      if (!this.signal.aborted) {
        this.uncertain = true;
        this.notice(this.t("knowledge.rulesSaveUnknown"));
      }
    } finally {
      if (!this.signal.aborted) {
        this.busy = false;
        this.controls();
      }
    }
    if (!this.signal.aborted) await this.refresh();
  }
  private async refresh() {
    this.statusRead?.abort();
    const read = new AbortController();
    this.statusRead = read;
    try {
      const status = await knowledgeRequest<KnowledgeGenerationStatus>(
        "/generation-status?" + new URLSearchParams({ project: this.project }),
        "GET",
        undefined,
        AbortSignal.any([this.signal, read.signal]),
      );
      if (!this.signal.aborted && !read.signal.aborted) {
        setMessageHtml(this.get("[data-rule-status]"), knowledgeRuleStatusHtml(status, this.t));
        if (status.policyRevision !== this.policy.revision) {
          this.uncertain = true;
          this.notice(this.t("knowledge.rulesSaveUnknown"));
          this.controls();
        }
      }
    } catch (error) {
      if (!this.signal.aborted && !read.signal.aborted) this.report(error);
    }
  }
}
