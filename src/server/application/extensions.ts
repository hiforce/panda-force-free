import { createTemplatePreviewFeature } from "../template-previews/feature.js";
import { HttpTemplatePreviewRenderer } from "../template-previews/http-renderer.js";
import { templatePreviewSamples } from "../template-previews/sample-adapter.js";
import { createPluginFeature } from "../plugins/integration/feature.js";
import { createSkillFeature } from "../skills/integration/feature.js";
import { createTemplateCatalogFeature } from "../templates/integration/feature.js";
import { createSkillWorkspaceFeature } from "../skill-workspace/feature.js";
import { createPortableTemplates } from "../templates/integration/portable-feature.js";
import { officeSourceProbe } from "../templates/integration/office-source-probe.js";
import { createNativeThemes } from "../templates/integration/native-feature.js";
import { createNativeSlidesTemplates } from "../templates/integration/native-slides-feature.js";
import { createNativeSampleFeature } from "../templates/integration/native-build-feature.js";
import { createPackageSourceFeature } from "../package-sources/feature.js";
import type { ApplicationConfig, ApplicationStores, ApplicationOwnerResolver } from "./types.js";
/** Register trusted source, template and skill features in dependency order without starting workers. */
export async function createApplicationExtensions(
  settings: ApplicationConfig,
  runtimeStores: ApplicationStores | null,
  resolveOwner: ApplicationOwnerResolver,
  env: NodeJS.ProcessEnv = process.env,
) {
  const pluginOptions = {
    stateRoot: settings.stateRoot,
    owner: resolveOwner,
    executorUrl: settings.buildExecutorUrl,
    tokenFile: settings.buildExecutorTokenFile,
  } satisfies Parameters<typeof createPluginFeature>[0];
  const pluginSelection = runtimeStores
    ? {
        driver: "mysql" as const,
        feature: createPluginFeature({ ...pluginOptions, persistence: runtimeStores.extensions.plugins }),
      }
    : { driver: "sqlite" as const, feature: createPluginFeature(pluginOptions) };
  const pluginFeature = pluginSelection.feature;
  const skillFeature = await createSkillFeature({
    registry: runtimeStores?.skills,
    stateRoot: settings.stateRoot,
    version: settings.version,
    owner: resolveOwner,
  });
  const packageSourceFeature = createPackageSourceFeature({
    store: runtimeStores?.extensions.packageSources.store,
    stateRoot: settings.stateRoot,
    owner: resolveOwner,
    diagnostic: (value) => console.warn("[PandaForce] Source task", value.code, value.id),
  });
  const portableTemplateFeature = createPortableTemplates({
    persistence: runtimeStores?.extensions.portable,
    stateRoot: settings.stateRoot,
    nativeThemeImport: true,
    sourceAdapters: [{ probe: officeSourceProbe, importableKinds: ["powerpoint-template", "powerpoint-bundle"] }],
    sourceReader: {
      project: (actor, id, read) => packageSourceFeature.ingestion.project(actor, "templates", id, read),
    },
    sourceConsumer: {
      consume: (actor, id, sha256, run) => packageSourceFeature.ingestion.consume(actor, "templates", id, sha256, run),
    },
    owner: resolveOwner,
  });
  const nativeThemeFeature = createNativeThemes({
    persistence: runtimeStores?.extensions.native,
    stateRoot: settings.stateRoot,
    owner: resolveOwner,
    sourceReader: {
      project: (actor, id, read) => packageSourceFeature.ingestion.project(actor, "templates", id, read),
    },
    sourceConsumer: {
      consume: (actor, id, sha256, run) => packageSourceFeature.ingestion.consume(actor, "templates", id, sha256, run),
    },
    runtimePool: packageSourceFeature.ingestion.runtime,
  });
  const nativeSlidesFeature = createNativeSlidesTemplates({
    persistence: runtimeStores?.extensions.nativeSlides,
    stateRoot: settings.stateRoot,
    owner: resolveOwner,
    sourceReader: {
      project: (actor, id, read) => packageSourceFeature.ingestion.project(actor, "templates", id, read),
    },
    sourceConsumer: {
      consume: (actor, id, sha256, run) => packageSourceFeature.ingestion.consume(actor, "templates", id, sha256, run),
    },
    runtimePool: packageSourceFeature.ingestion.runtime,
  });

  const skillWorkspaceFeature = createSkillWorkspaceFeature({
    store: runtimeStores?.skillWorkspace,
    stateRoot: settings.stateRoot,
    owner: resolveOwner,
  });
  const templateCatalogFeature = createTemplateCatalogFeature({
    presentation: () => pluginFeature.service.snapshot(),
    skills: (cursor, limit) => skillFeature.catalog.list(cursor, limit),
    collection: skillWorkspaceFeature.collection,
    portable: () => portableTemplateFeature.inspection.snapshot(),
    native: (actor) => nativeThemeFeature.service.snapshot(actor),
    nativeSlides: (actor) => nativeSlidesFeature.service.snapshot(actor),
    owner: resolveOwner,
  });
  const nativeSampleFeature = createNativeSampleFeature({
    jobs: runtimeStores?.extensions.nativeSamples.jobs,
    stateRoot: settings.stateRoot,
    themes: nativeThemeFeature.service,
    runtimePool: packageSourceFeature.ingestion.runtime,
    owner: resolveOwner,
    executorUrl: settings.buildExecutorUrl,
    tokenFile: settings.buildExecutorTokenFile,
  });
  const templatePreviewFeature = createTemplatePreviewFeature({
    ...runtimeStores?.extensions.templatePreviews,
    stateRoot: settings.stateRoot,
    owner: resolveOwner,
    authority: { resolve: (actor, key) => templateCatalogFeature.catalog.get(key, actor) },
    samples: templatePreviewSamples({
      catalog: pluginFeature.samples,
      catalogPreview: pluginFeature.samplePreview,
      native: nativeSampleFeature.service,
      nativePreview: nativeSampleFeature.preview,
    }),
    renderer:
      env.PANDA_FORCE_PREVIEW_RENDERER_URL && env.PANDA_FORCE_PREVIEW_TOKEN_FILE
        ? new HttpTemplatePreviewRenderer(env.PANDA_FORCE_PREVIEW_RENDERER_URL, env.PANDA_FORCE_PREVIEW_TOKEN_FILE)
        : null,
  });

  return {
    pluginSelection,
    pluginFeature,
    skillFeature,
    packageSourceFeature,
    portableTemplateFeature,
    nativeThemeFeature,
    nativeSlidesFeature,
    skillWorkspaceFeature,
    templateCatalogFeature,
    nativeSampleFeature,
    templatePreviewFeature,
  };
}
