import { expect, test } from "bun:test";
import { nativeThemeProposal } from "../../src/server/templates/native/proposal.js";
import { nativeFiles, nativeZipSource, nativeThemeFixture, nativeSettings } from "../support/native-theme.js";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { nativeThemeCatalogSource } from "../../src/server/templates/integration/native-catalog.js";

test("theme proposals read bounded metadata and ancestor licenses without executing config or adopting another package's documentation", async () => {
  const f = await nativeZipSource({
    ...nativeFiles,
    "theme/package.json": JSON.stringify({
      name: "@example/theme",
      version: "2.1.0",
      description: "<script>Never execute</script>",
      author: { name: "Example author" },
      license: "MIT",
      dependencies: { renderer: "^1.0.0" },
      scripts: { install: "throw Error('NEVER_RUN')" },
    }),
    "theme/config.js": "throw Error('NEVER_LOAD');",
    "other/LICENSE": "Unrelated private license",
    "other/README.md": "Unrelated private instructions",
  });
  const value = nativeThemeProposal(f.source, "theme", "hexo");
  expect(value.settings.id).toBe("example.theme");
  expect(value.settings.version).toBe("2.1.0");
  expect(value.settings.publisher).toBe("Example author");
  expect(value.settings.dependencies).toEqual({ renderer: "^1.0.0" });
  expect(value.licenseFiles).toEqual(["LICENSE"]);
  expect(value.licenseText).toBe("MIT fixture license");
  expect(value.readmeText).toBe("Native theme usage");
  expect(JSON.stringify(value)).not.toContain("NEVER_RUN");
  const unrelated = await nativeZipSource({
      "theme/index.js": "module.exports = () => ({ name: 'theme' });",
      "other/LICENSE": "Unrelated license",
      "other/README.md": "Unrelated documentation",
    }),
    proposal = nativeThemeProposal(unrelated.source, "theme", "docusaurus");
  expect(proposal.licenseFiles).toEqual([]);
  expect(proposal.readmeText).toBe("");
  expect(proposal.settings.entry).toBe("index.js");
  const invalid = await nativeZipSource({
      ...nativeFiles,
      "theme/package.json": '{"SOURCE_BYTES_NOT_FOR_ERRORS":',
      "theme/README.md": "x".repeat(512 * 1024 + 1),
    }),
    rejected = nativeThemeProposal(invalid.source, "theme", "hexo");
  expect(rejected.issues).toEqual([
    { path: "theme/package.json", code: "metadataInvalid" },
    { path: "theme/README.md", code: "metadataTooLarge" },
  ]);
  expect(JSON.stringify(rejected)).not.toContain("SOURCE_BYTES_NOT_FOR_ERRORS");
});

test("native catalog reads and cursor binding remain principal-scoped and advertise native source export and build previews", async () => {
  const f = await nativeThemeFixture(),
    { source } = await nativeZipSource();
  try {
    const service = f.service();
    for (const version of ["1.0.0", "2.0.0"]) {
      const command = await f.command(service, source, nativeSettings(version));
      await service.install("owner", command.input);
    }
    const catalog = new TemplateCatalog([nativeThemeCatalogSource((actor) => service.snapshot(actor))]),
      page = await catalog.list({ limit: 1 }, "owner");
    expect(page.total).toBe(2);
    expect(page.nextCursor).not.toBeNull();
    expect(page.templates[0]!.reference.registry).toBe("native");
    expect(page.templates[0]!.actions).toMatchObject({
      preview: "site-build",
      export: "native-zip",
      editor: null,
      setEnabled: true,
    });
    expect(JSON.stringify(page)).not.toContain("Owner-only original resource");
    expect((await catalog.list({ limit: 1 }, "other")).templates).toEqual([]);
    expect((await catalog.list({ limit: 1 })).templates).toEqual([]);
    await expect(catalog.list({ limit: 1, cursor: page.nextCursor! }, "other")).rejects.toThrow("catalogChanged");
    const next = await catalog.list({ limit: 1, cursor: page.nextCursor! }, "owner");
    expect(next.templates[0]!.reference.version).toBe("2.0.0");
    const sameRevisions = new TemplateCatalog([
        {
          registry: "native",
          async read() {
            return { registry: "native", revision: "same", templates: [...page.templates, ...next.templates] };
          },
        },
      ]),
      principalPage = await sameRevisions.list({ limit: 1 }, "owner");
    await expect(sameRevisions.list({ limit: 1, cursor: principalPage.nextCursor! }, "second-owner")).rejects.toThrow(
      "catalogChanged",
    );
    const theme = page.templates[0]!.reference;
    if (theme.registry !== "native") throw Error("Wrong catalog reference");
    service.state(
      "owner",
      { id: theme.id, version: theme.version, digest: theme.digest },
      "disable",
      service.snapshot("owner").revision,
    );
    await expect(catalog.list({ limit: 1, cursor: page.nextCursor! }, "owner")).rejects.toThrow("catalogChanged");
  } finally {
    await f.close();
  }
}, 15_000);
