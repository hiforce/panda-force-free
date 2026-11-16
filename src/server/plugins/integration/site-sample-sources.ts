import type { MetadataStore } from "../../../shared/async-value.js";
import type { SiteThemeMetadataCatalog } from "../presentation-ports.js";
import type { SiteThemeCatalog } from "../../../shared/presentation/themes.js";
import type { BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import type { SiteExecutor } from "../../builds/executor-port.js";
import type { BuildAuthorityPort } from "../../builds/authority.js";
import { SiteBuildError } from "../../builds/errors.js";
import { assertBuildCapabilities } from "../../builds/capabilities.js";
import { PUBLIC_STYLE_SAMPLE } from "../../../shared/presentation/sample-content.js";
import type { SiteSampleSources, TemplateLibraryStore } from "../ports.js";
import { readVerifiedTemplateDraft } from "../definition.js";
import { PluginRegistryError } from "../errors.js";
import { definitionSiteSample, sampleCapture, siteSampleInput } from "./site-sample-input.js";

export function siteSampleSources(options: {
  themes: SiteThemeMetadataCatalog;
  captureTheme: (theme: ReturnType<SiteThemeCatalog["resolve"]>) => Promise<BuildThemeSnapshot>;
  drafts: MetadataStore<TemplateLibraryStore>;
  executor: SiteExecutor | null;
  authorize: BuildAuthorityPort;
}): SiteSampleSources {
  return {
    async capture(source) {
      if (source.kind === "catalog") {
        const theme = await options.themes.resolve(source.reference, source.engine),
          frozen = await options.captureTheme(theme);
        return sampleCapture(siteSampleInput(frozen, { id: "style-sample", ...PUBLIC_STYLE_SAMPLE }), {
          source,
          fixtureId: "style-sample",
          ...(frozen.package ? { packageDigest: frozen.package.digest } : {}),
        });
      }
      const draft = await readVerifiedTemplateDraft(options.drafts, source.id);
      if (draft.revision !== source.revision) throw new PluginRegistryError("libraryConflict");
      const snapshot = await definitionSiteSample(draft.definition, source.fixtureId);
      if ((await options.drafts.get(source.id)).revision !== source.revision)
        throw new PluginRegistryError("libraryConflict");
      return sampleCapture(snapshot.input, {
        source,
        fixtureId: source.fixtureId,
        definitionDigest: snapshot.definitionDigest,
        packageDigest: snapshot.packageDigest,
      });
    },
    async assertAvailable(input) {
      const available = await options.executor?.availability();
      if (!available || available.state !== "ready" || !available.engines[input.engine])
        throw new SiteBuildError(
          !available || available.state === "unconfigured" ? "executorUnconfigured" : "executorUnavailable",
          503,
        );
      assertBuildCapabilities(input, available);
    },
    authorize: options.authorize,
  };
}
