import { join } from "node:path";
import type { RouteContext } from "../http/router.js";
import type { TemplatePreviewAuthority, TemplatePreviewSamples, TemplatePreviewRenderer } from "./ports.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { TemplatePreviewRepository } from "./repository.js";
import { FileTemplatePreviewImages } from "./files.js";
import { TemplatePreviewService } from "./service.js";
import { templatePreviewRoutes } from "./routes.js";
import type { MetadataStore } from "../../shared/async-value.js";
import type { TemplatePreviewJobs } from "./ports.js";
export function createTemplatePreviewFeature(options: {
  stateRoot: string;
  owner(context: RouteContext): string;
  authority: TemplatePreviewAuthority;
  samples: TemplatePreviewSamples;
  renderer: TemplatePreviewRenderer | null;
  jobs?: MetadataStore<TemplatePreviewJobs>;
}) {
  if (options.jobs !== undefined && !options.jobs) throw new Error("templatePreviewStorageRequired");
  const root = join(options.stateRoot, "templates", "previews"),
    owned = options.jobs ? null : new TemplatePreviewRepository(join(root, "jobs.sqlite")),
    jobs = options.jobs ?? owned!;
  const service = new TemplatePreviewService(
    jobs,
    options.authority,
    options.samples,
    options.renderer,
    new FileTemplatePreviewImages(join(root, "images")),
    (error) => reportDiagnostic("template-preview", error),
  );
  let closing: Promise<void> | undefined;
  return {
    service,
    routes: templatePreviewRoutes(service, options.owner),
    start: () => service.wake(),
    close: () => (closing ??= service.close().then(() => owned?.close())),
  };
}
