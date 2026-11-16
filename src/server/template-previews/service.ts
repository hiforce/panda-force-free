import { createHash } from "node:crypto";
import { TEMPLATE_PREVIEW_RENDERER } from "../../shared/template-previews/contracts.js";
import type {
  TemplatePreviewAuthority,
  TemplatePreviewImageStore,
  TemplatePreviewRenderer,
  TemplatePreviewSamples,
} from "./ports.js";
import type { MetadataStore } from "../../shared/async-value.js";
import type { TemplatePreviewJobs } from "./ports.js";
import { TemplatePreviewError } from "./errors.js";
import { isSupportedLocale } from "../../shared/i18n/locale-policy.js";
import type { SupportedLocale } from "../../shared/i18n/contracts.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const templatePreviewCacheKey = (key: string, locale: string) =>
  hash({
    template: key,
    locale,
    sample: "public-site-samples/v2",
    renderer: TEMPLATE_PREVIEW_RENDERER,
    viewports: "1440x960,390x844",
  });
const uuid = (value: string) => {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Authority, durable intent, sample execution, rasterization and binary storage remain separate ports. */
export class TemplatePreviewService {
  private closed = false;
  private current: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controls = new Set<Promise<unknown>>();
  constructor(
    private readonly jobs: MetadataStore<TemplatePreviewJobs>,
    private readonly authority: TemplatePreviewAuthority,
    private readonly samples: TemplatePreviewSamples,
    private readonly renderer: TemplatePreviewRenderer | null,
    private readonly images: TemplatePreviewImageStore,
    private readonly diagnostic: (error: unknown) => void,
    private readonly now = Date.now,
  ) {}
  async require(actor: string, key: string) {
    if (this.closed) throw new TemplatePreviewError("unavailable");
    if (!actor || actor.length > 200 || typeof key !== "string" || key.length > 1500)
      throw new TemplatePreviewError("invalidInput");
    let value;
    try {
      value = await this.authority.resolve(actor, key);
    } catch {
      throw new TemplatePreviewError("notFound");
    }
    if (this.closed) throw new TemplatePreviewError("unavailable");
    if (value.state.removed) throw new TemplatePreviewError("notFound");
    if (!value.state.enabled) throw new TemplatePreviewError("disabled");
    if (
      value.templateType !== "panda.site-theme" ||
      !["builtin", "presentation", "native"].includes(value.reference.registry)
    )
      throw new TemplatePreviewError("unsupported");
    return value;
  }
  async lookup(actor: string, key: string, locale: SupportedLocale) {
    if (!isSupportedLocale(locale)) throw new TemplatePreviewError("invalidInput");
    await this.require(actor, key);
    return this.jobs.lookup(actor, templatePreviewCacheKey(key, locale));
  }
  start(actor: string, id: string, key: string, locale: SupportedLocale) {
    return this.control(this.startCommand(actor, id, key, locale));
  }
  private async startCommand(actor: string, id: string, key: string, locale: SupportedLocale) {
    await this.require(actor, key);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || !isSupportedLocale(locale))
      throw new TemplatePreviewError("invalidInput");
    if (!this.renderer) throw new TemplatePreviewError("unavailable");
    const now = this.now(),
      job = await this.jobs.reserve(actor, {
        id,
        key: templatePreviewCacheKey(key, locale),
        templateKey: key,
        locale,
        phase: "queued",
        createdAt: now,
        updatedAt: now,
        generation: 1,
        attempts: 0,
        failure: null,
        images: {},
      });
    this.wake();
    return job;
  }
  async detail(actor: string, id: string) {
    const job = await this.jobs.get(actor, id);
    await this.require(actor, job.templateKey);
    return job;
  }
  retry(actor: string, id: string) {
    return this.control(this.retryCommand(actor, id));
  }
  private async retryCommand(actor: string, id: string) {
    await this.detail(actor, id);
    if (!this.renderer) throw new TemplatePreviewError("unavailable");
    const job = await this.jobs.retry(actor, id);
    this.wake();
    return job;
  }
  async image(actor: string, id: string, view: "home" | "article" | "mobile") {
    return this.images.read(await this.detail(actor, id), view);
  }
  private async step() {
    const claim = await this.jobs.claim();
    if (!claim) return;
    const { owner, job, token } = claim;
    let phase = "building";
    try {
      const template = await this.require(owner, job.templateKey);
      await this.jobs.progress(job.id, token, "building");
      const pages = await this.samples.pages(owner, template, uuid(`${job.id}:${job.generation}:${job.attempts}`));
      if (pages.state === "waiting") {
        await this.jobs.save(job.id, token, { phase: "building" }, 1500);
        return;
      }
      phase = "rendering";
      await this.jobs.progress(job.id, token, "rendering");
      if (!this.renderer) throw new TemplatePreviewError("unavailable");
      const raster = await this.renderer.render(
        {
          schema: 1,
          renderer: TEMPLATE_PREVIEW_RENDERER,
          locale: job.locale,
          home: pages.home,
          article: pages.article,
        },
        this.abort.signal,
      );
      await this.require(owner, job.templateKey);
      const images = await this.images.write(job.id, raster);
      await this.require(owner, job.templateKey);
      await this.jobs.save(job.id, token, { phase: "ready", images, failure: null });
    } catch (error) {
      if (this.abort.signal.aborted) {
        await this.jobs.save(job.id, token, { phase: "queued" });
        return;
      }
      this.diagnostic(error);
      await this.jobs.save(job.id, token, {
        phase: "failed",
        attempts: job.attempts + 1,
        failure: phase === "rendering" ? "renderUnavailable" : "buildFailed",
      });
    }
  }
  wake() {
    if (this.closed || this.current) return;
    clearTimeout(this.timer);
    this.current = this.step()
      .catch(this.diagnostic)
      .finally(() => {
        this.current = null;
        if (!this.closed) {
          this.timer = setTimeout(() => this.wake(), 750);
          this.timer.unref();
        }
      });
  }
  private control<T>(pending: Promise<T>): Promise<T> {
    this.controls.add(pending);
    return pending.finally(() => this.controls.delete(pending));
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.abort.abort();
    await this.current;
    await Promise.allSettled(this.controls);
  }
}
