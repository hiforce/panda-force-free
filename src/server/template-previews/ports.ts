import type {
  TemplatePreviewInput,
  TemplatePreviewRaster,
  TemplatePreviewJob,
} from "../../shared/template-previews/contracts.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
export interface TemplatePreviewAuthority {
  resolve(actor: string, key: string): Promise<ManagedTemplate>;
}
export interface TemplatePreviewSamples {
  pages(
    actor: string,
    template: ManagedTemplate,
    operationId: string,
  ): Promise<{ state: "waiting" } | { state: "ready"; home: string; article: string }>;
}
export interface TemplatePreviewRenderer {
  render(input: TemplatePreviewInput, signal: AbortSignal): Promise<TemplatePreviewRaster>;
}
export interface TemplatePreviewImageStore {
  write(id: string, raster: TemplatePreviewRaster): Promise<TemplatePreviewJob["images"]>;
  read(job: TemplatePreviewJob, view: "home" | "article" | "mobile"): Promise<Uint8Array>;
}
/** Durable metadata and lease authority; image bytes remain in the file cache. */
export interface TemplatePreviewJobs {
  get(owner: string, id: string): TemplatePreviewJob;
  lookup(owner: string, key: string): TemplatePreviewJob | null;
  reserve(owner: string, input: TemplatePreviewJob): TemplatePreviewJob;
  claim(): { owner: string; job: TemplatePreviewJob; token: string } | null;
  progress(id: string, token: string, phase: "building" | "rendering"): void;
  save(
    id: string,
    token: string,
    changes: Partial<Pick<TemplatePreviewJob, "phase" | "images" | "failure" | "attempts">>,
    delay?: number,
  ): TemplatePreviewJob;
  retry(owner: string, id: string): TemplatePreviewJob;
}
