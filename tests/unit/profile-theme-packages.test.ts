import { expect, test } from "bun:test";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";
import { profileThemePackage as profiles } from "../support/profile-theme-package.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezePackageProfile } from "../../src/shared/builds/profile-theme.js";
import {
  freezeBuildTheme,
  freezeDeclarativeBuildTheme,
  verifyBuildTheme,
  buildThemeMetadata,
} from "../../src/shared/builds/theme.js";
import { builtinSiteThemes } from "../../src/shared/presentation/themes.js";
import { PluginRegistryService } from "../../src/server/plugins/service.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { FilePluginBundles } from "../../src/server/plugins/storage/bundles.js";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { installedPresentation } from "../../src/server/plugins/integration/presentation.js";
import { builtinBuildAuthority } from "../../src/server/builds/authority.js";
import type { BuildInput } from "../../src/shared/builds/contracts.js";
import { siteThemeCss } from "../../src/document-worker/theme.js";
import { packageSourceTheme } from "../../src/server/plugins/authoring.js";

test("declarative profiles are portable data with no code grant or resource tree", async () => {
  const value = profiles(),
    verified = await verifyPluginPackage(value);
  expect(verified.package.manifest.permissions).toEqual(["content:site-themes"]);
  expect(verified.fileCount).toBe(0);
  expect((await verifyPluginPackage(JSON.parse(JSON.stringify(value)))).digest).toBe(verified.digest);
  const changed = profiles();
  changed.manifest.siteThemes[0]!.name = "A new label";
  expect((await verifyPluginPackage(changed)).digest).not.toBe(verified.digest);
  await expect(freezeTrustedBuildTheme(value, "journal")).rejects.toThrow("invalidTheme");
});
test("profile declarations cannot smuggle code, arbitrary CSS, paths or excess permissions", async () => {
  for (const patch of [
    { root: "themes/journal" },
    { entry: "index.js" },
    { dependencies: { react: "19.0.0" } },
    {
      profile: {
        layout: "journal",
        font: "sans",
        accent: "url(https://private.invalid)",
        width: 760,
        density: "compact",
      },
    },
    { profile: { layout: "handbook", font: "sans", accent: "#112233", width: 760, density: "compact" } },
    { profile: { layout: "journal", font: "sans;display:none", accent: "#112233", width: 760, density: "compact" } },
  ]) {
    const value = profiles();
    Object.assign(value.manifest.siteThemes[0]!, patch);
    await expect(verifyPluginPackage(value)).rejects.toThrow();
  }
  const excess = profiles();
  excess.manifest.permissions.push("build:theme-code");
  await expect(verifyPluginPackage(excess)).rejects.toThrow("permissionMismatch");
  const file = profiles();
  file.files = [{ path: "themes/journal/code.js", data: btoa("code"), sha256: "0".repeat(64) }];
  await expect(verifyPluginPackage(file)).rejects.toThrow("invalidPackagePath");
});
test("adding profile support preserves the canonical identity and code grant of existing packages", async () => {
  const verified = await verifyPluginPackage(exampleThemePackage());
  expect(verified.digest).toBe("3b98cb769a4bd01a8c935b9f39e241fb800d3b9ea19382a4722eadf07e28a551");
  expect(verified.package.manifest.permissions).toContain("build:theme-code");
});
test("a declarative package cannot request source-tree reads from the executable-theme authoring adapter", async () => {
  const value = profiles();
  value.manifest.siteThemes = value.manifest.siteThemes.slice(0, 1);
  let reads = 0;
  await expect(
    packageSourceTheme(value.manifest, {
      async *files() {
        reads++;
        yield { path: "layout.ejs", bytes: new TextEncoder().encode("A source") };
      },
      async verify() {
        reads++;
      },
    }),
  ).rejects.toThrow("invalidPackage");
  expect(reads).toBe(0);
});
test("frozen profile provenance is verified, covered by the input digest and independent of template code", async () => {
  const value = profiles(),
    verified = await verifyPluginPackage(value);
  const frozen = await freezePackageProfile(value, "journal");
  expect(frozen.schema).toBe(1);
  expect(frozen.package).toEqual({ id: value.manifest.id, version: value.manifest.version, digest: verified.digest });
  expect(frozen).not.toHaveProperty("bundle");
  expect(await verifyBuildTheme(frozen, "hexo")).toEqual(frozen);
  expect(buildThemeMetadata(frozen)).toEqual(frozen);
  const withoutIdentity = structuredClone(frozen);
  delete withoutIdentity.package;
  await expect(verifyBuildTheme(withoutIdentity, "hexo")).rejects.toThrow("themeDigestMismatch");
  const alteredIdentity = structuredClone(frozen);
  alteredIdentity.package!.digest = "0".repeat(64);
  await expect(verifyBuildTheme(alteredIdentity, "hexo")).rejects.toThrow("themeDigestMismatch");
  const otherNamespace = structuredClone(frozen);
  otherNamespace.package!.id = "different.author";
  await expect(verifyBuildTheme(otherNamespace, "hexo")).rejects.toThrow("invalidTheme");
  await expect(freezePackageProfile(exampleThemePackage(), "journal")).rejects.toThrow("invalidTheme");
  expect((await freezeBuildTheme(builtinSiteThemes.resolve("default", "hexo"))).sha256).toBe(
    "dc0ff3f06973c5e3ae6960470962adde3afbc523534011440ad13356eec5a5f0",
  );
});
test("installed profile captures retain approval identity and disabling blocks new authority without blocking exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-registry-"));
  const db = openPluginDatabase(join(root, "plugins.sqlite"));
  try {
    const service = new PluginRegistryService(
      new SqlitePluginRegistry(db),
      new FilePluginBundles(join(root, "bundles")),
    );
    const value = profiles(),
      review = await service.review(value);
    const installed = await service.install(
      value,
      {
        digest: review.digest,
        expectedRevision: review.revision,
        permissions: review.permissions,
      },
      "test:owner",
    );
    const catalog = installedPresentation(service);
    const selected = catalog.themes.resolve("example.profiles.journal@1.0.0", "hexo");
    expect(selected.profile!.font).toBe("serif");
    const frozen = await catalog.captureTheme(selected);
    const input: BuildInput = {
      protocol: 1,
      engine: "hexo",
      preset: "reader",
      site: { title: "Sample", url: "https://example.test", basePath: "/", locale: "en" },
      documents: [{ id: "sample", path: "article.md", title: "Sample", content: "A sample" }],
      assets: [],
      theme: frozen,
    };
    expect(() => builtinBuildAuthority(input)).toThrow("themeNotApproved");
    expect(() => catalog.authorizeBuild(input)).not.toThrow();
    if (frozen.schema !== 1) throw Error("Expected a declarative profile");
    const { density, width, accent, font, layout } = frozen.profile;
    const reordered = { ...frozen, profile: { density, width, accent, font, layout } };
    expect(() => catalog.authorizeBuild({ ...input, theme: reordered })).not.toThrow();
    expect(await verifyBuildTheme(reordered, "hexo")).toEqual(frozen);
    const { sha256: _sha256, ...profileData } = await freezePackageProfile(value, "journal");
    const forged = await freezeDeclarativeBuildTheme({
      ...profileData,
      profile: { ...profileData.profile, accent: "#123456" },
    });
    expect(() => catalog.authorizeBuild({ ...input, theme: forged })).toThrow("themeNotApproved");
    expect(siteThemeCss(input)).toContain("#845738");
    service.setEnabled(installed.id, installed.version, false, service.snapshot().revision, "test:owner");
    expect(() => catalog.authorizeBuild(input)).toThrow("themeNotApproved");
    await expect(catalog.captureTheme(selected)).rejects.toThrow("packageDisabled");
    expect((await service.exportPackage(installed.id, installed.version)).digest).toBe(review.digest);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
