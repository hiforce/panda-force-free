import { BUILD_ENGINES, type BuildInput } from "../../../shared/builds/contracts.js";
import { buildInput } from "../../../shared/builds/validation.js";
import { freezePackageProfile } from "../../../shared/builds/profile-theme.js";
import { freezeTrustedBuildTheme } from "../../../shared/builds/trusted-theme.js";
import type { BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import { SITE_SAMPLE_RUNNER, type SiteSampleContext } from "../../../shared/plugins/site-samples.js";
import { verifyTemplateDefinition } from "../../../shared/plugins/library-validation.js";
import { canonicalPackageJson, packageSha256 } from "../../../shared/plugins/validation.js";
import { isProfileTheme } from "../../../shared/plugins/contracts.js";
import type { TemplateDefinition, TemplateFixture } from "../../../shared/plugins/library.js";
import type { SiteSampleCapture } from "../ports.js";
import { PluginRegistryError } from "../errors.js";

export function siteSampleInput(
  theme: BuildThemeSnapshot,
  fixture: Pick<TemplateFixture, "id" | "title" | "locale" | "content">,
): SiteSampleCapture["input"] {
  const parsed = buildInput({
    protocol: 1,
    engine: theme.engine,
    preset: theme.engine === "hexo" ? "reader" : "handbook",
    theme,
    site: { title: fixture.title, locale: fixture.locale, url: "https://sample.example.test", basePath: "/" },
    documents: [{ id: fixture.id, path: "sample.md", title: fixture.title, content: fixture.content }],
    assets: [],
  });
  if (!parsed.theme) throw new PluginRegistryError("invalidLibraryDraft");
  return { ...parsed, theme: parsed.theme };
}
/** Baseline and archive metadata never affect execution identity; engine and runner versions always do. */
export function siteSampleKey(input: BuildInput) {
  return packageSha256(
    canonicalPackageJson({ runnerVersion: SITE_SAMPLE_RUNNER, engineVersion: BUILD_ENGINES[input.engine], input }),
  );
}
export async function sampleCapture(
  input: SiteSampleCapture["input"],
  context: Omit<SiteSampleContext, "runnerVersion" | "engineVersion">,
): Promise<SiteSampleCapture> {
  return {
    key: await siteSampleKey(input),
    input,
    context: { ...context, runnerVersion: SITE_SAMPLE_RUNNER, engineVersion: BUILD_ENGINES[input.engine] },
  };
}
export async function definitionSiteSample(definition: TemplateDefinition, fixtureId: string) {
  const checked = await verifyTemplateDefinition(definition),
    fixture = checked.definition.fixtures.find((item) => item.id === fixtureId);
  if (!fixture || fixture.kind !== "site" || fixture.engine === "markdown")
    throw new PluginRegistryError("invalidLibraryDraft");
  const entry = checked.definition.package.manifest.siteThemes.find((item) => item.id === fixture.exportId);
  if (!entry || entry.engine !== fixture.engine) throw new PluginRegistryError("invalidLibraryDraft");
  const theme = await (isProfileTheme(entry)
    ? freezePackageProfile(checked.definition.package, entry.id)
    : freezeTrustedBuildTheme(checked.definition.package, entry.id));
  return {
    input: siteSampleInput(theme, fixture),
    fixture,
    definitionDigest: checked.digest,
    packageDigest: checked.packageDigest,
  };
}
