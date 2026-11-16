import type { TemplateDefinition, TemplateArchive, TemplateFixture } from "./library.js";
import { TEMPLATE_LIBRARY_LIMITS } from "./library.js";
import { PluginPackageError } from "./contracts.js";
import { verifyPluginPackage } from "./package.js";
import { packageRecord, packageText, packageSha256, canonicalPackageJson } from "./validation.js";

function archive(value: unknown): TemplateArchive {
  const input = packageRecord(value, [
    "author",
    "license",
    "licenseText",
    "sourceUrl",
    "sourceRevision",
    "changelog",
    "compatibility",
  ]);
  const result = {
    author: packageText(input.author, 120),
    license: packageText(input.license, 100),
    licenseText: packageText(input.licenseText, 64000, true),
    sourceUrl: packageText(input.sourceUrl, 1000, true),
    sourceRevision: packageText(input.sourceRevision, 160, true),
    changelog: packageText(input.changelog, 16000, true),
    compatibility: packageText(input.compatibility, 16000, true),
  };
  if (result.sourceUrl) {
    let url: URL;
    try {
      url = new URL(result.sourceUrl);
    } catch {
      throw new PluginPackageError("invalidPackage");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new PluginPackageError("invalidPackage");
    result.sourceUrl = url.href;
  }
  return result;
}
/** Library metadata and fixtures are separate from the legacy package identity and worker protocol. */
export async function verifyTemplateDefinition(value: unknown) {
  const input = packageRecord(value, ["schema", "package", "archive", "fixtures"]);
  if (input.schema !== 1 || !Array.isArray(input.fixtures) || input.fixtures.length > TEMPLATE_LIBRARY_LIMITS.fixtures)
    throw new PluginPackageError("invalidPackage");
  const bundle = await verifyPluginPackage(input.package),
    ids = new Set<string>();
  let bytes = 0;
  const fixtures: TemplateFixture[] = input.fixtures.map((value) => {
    const entry = packageRecord(value, [
      "id",
      "name",
      "kind",
      "exportId",
      "engine",
      "locale",
      "title",
      "content",
      "format",
      "expectedDigest",
    ]);
    const fixture: TemplateFixture = {
      id: packageText(entry.id, 80),
      name: packageText(entry.name, 160),
      kind: entry.kind as TemplateFixture["kind"],
      exportId: packageText(entry.exportId, 80),
      engine: entry.engine as TemplateFixture["engine"],
      locale: packageText(entry.locale, 35),
      title: packageText(entry.title, 200),
      content: packageText(entry.content, 65536, true),
      expectedDigest: entry.expectedDigest as string | null,
    };
    if (
      !/^[a-z][a-z0-9_-]{0,79}$/.test(fixture.id) ||
      ids.has(fixture.id) ||
      !/^([a-z]{2,3})(-[a-zA-Z0-9]{2,8})*$/.test(fixture.locale) ||
      !["markdown", "hexo", "docusaurus"].includes(fixture.engine) ||
      (fixture.expectedDigest !== null &&
        (typeof fixture.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(fixture.expectedDigest)))
    )
      throw new PluginPackageError("invalidPackage");
    ids.add(fixture.id);
    bytes += new TextEncoder().encode(fixture.content).length;
    if (bytes > TEMPLATE_LIBRARY_LIMITS.sourceBytes) throw new PluginPackageError("packageTooLarge");
    if (fixture.kind === "channel") {
      const target = bundle.package.manifest.channelTemplates.find((item) => item.id === fixture.exportId);
      if (!target || !target.formats.some((format) => format === entry.format))
        throw new PluginPackageError("invalidPackage");
      fixture.format = entry.format as NonNullable<TemplateFixture["format"]>;
    } else if (fixture.kind === "site") {
      const target = bundle.package.manifest.siteThemes.find((item) => item.id === fixture.exportId);
      if (!target || target.engine !== fixture.engine || entry.format !== undefined)
        throw new PluginPackageError("invalidPackage");
    } else throw new PluginPackageError("invalidPackage");
    return fixture;
  });
  const definition: TemplateDefinition = {
    schema: 1,
    package: bundle.package,
    archive: archive(input.archive),
    fixtures,
  };
  const json = canonicalPackageJson(definition);
  if (new TextEncoder().encode(json).length > TEMPLATE_LIBRARY_LIMITS.jsonBytes)
    throw new PluginPackageError("packageTooLarge");
  return { definition, packageDigest: bundle.digest, digest: await packageSha256(json) };
}
export function templateFixtureCoverage(definition: TemplateDefinition): string[] {
  const coverage = new Set(
    definition.fixtures.map((f) => `${f.kind}:${f.exportId}${f.kind === "channel" ? ":" + f.format : ""}`),
  );
  return [
    ...definition.package.manifest.siteThemes.map((t) => `site:${t.id}`),
    ...definition.package.manifest.channelTemplates.flatMap((t) =>
      t.formats.map((format) => `channel:${t.id}:${format}`),
    ),
  ].filter((key) => !coverage.has(key));
}
