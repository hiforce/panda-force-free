import type { SiteSampleServicePort } from "../plugins/site-sample-service.js";
import type { NativeSampleServicePort } from "../builds/native/service.js";
import type { SiteBuildPreview } from "../builds/preview.js";
import type { TemplatePreviewSamples } from "./ports.js";
import { TemplatePreviewError } from "./errors.js";
import { terminalBuildRun } from "../../shared/builds/run.js";

/** Fixed sample builders own theme execution. This adapter only inspects their sanitized, self-contained static output. */
export function templatePreviewSamples(options: {
  catalog: SiteSampleServicePort;
  catalogPreview(actor: string): SiteBuildPreview;
  native: NativeSampleServicePort;
  nativePreview(actor: string): SiteBuildPreview;
}): TemplatePreviewSamples {
  return {
    async pages(actor, template, id) {
      const ref = template.reference;
      let preview: SiteBuildPreview, build;
      if (ref.registry === "native") {
        const theme = { id: ref.id, version: ref.version, digest: ref.digest };
        build = await options.native.lookup(actor, theme);
        if (!build || (terminalBuildRun(build) && (build.phase !== "completed" || !build.artifactAvailable)))
          build = await options.native.start(actor, { id, theme });
        preview = options.nativePreview(actor);
      } else if (ref.registry === "builtin" || ref.registry === "presentation") {
        const reference = ref.registry === "builtin" ? ref.id : ref.packageId + "." + ref.exportId;
        const source = {
          kind: "catalog" as const,
          engine: template.compatibility.engines[0]!,
          reference: reference + "@" + ref.version,
        };
        build = await options.catalog.lookup(source, actor);
        if (!build || (terminalBuildRun(build) && (build.phase !== "completed" || !build.artifactAvailable)))
          build = await options.catalog.start({ id, source }, actor);
        preview = options.catalogPreview(actor);
      } else throw new TemplatePreviewError("unsupported");
      if (build.phase !== "completed" || !build.artifactAvailable) {
        if (terminalBuildRun(build)) throw new TemplatePreviewError("unavailable");
        return { state: "waiting" };
      }
      const paths = await preview.pages(build.id);
      const homePath = paths.includes("index.html") ? "index.html" : paths[0];
      const articlePath =
        paths.find((path) => path !== homePath && /sample|style-sample/.test(path)) ??
        paths.find((path) => path !== homePath);
      if (!homePath || !articlePath) throw new TemplatePreviewError("unsupported");
      const home = await preview.file(build.id, homePath),
        article = await preview.file(build.id, articlePath);
      return {
        state: "ready",
        home: Buffer.from(home.bytes).toString("utf8"),
        article: Buffer.from(article.bytes).toString("utf8"),
      };
    },
  };
}
