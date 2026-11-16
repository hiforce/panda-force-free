import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { discoverTemplateSource } from "../../src/server/templates/sources/discovery.js";

async function inspect(files: Record<string, string>) {
  const bytes = zipSync(
      Object.fromEntries(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)])),
    ),
    source = await captureSourceSnapshot(await openZipSource(bytes, "templates.zip"), undefined, bytes);
  return { source, result: await discoverTemplateSource(source) };
}
test("native discovery identifies independent nested theme roots and keeps scripts as immutable source bytes", async () => {
  const { source, result } = await inspect({
    "release/themes/first/layout/index.ejs": "<h1>Source</h1>",
    "release/themes/first/scripts/config.js": "throw Error('NEVER_EXECUTE');",
    "release/themes/second/layout/page.njk": "{{ title }}",
    "node_modules/vendor/layout/index.ejs": "Not a selectable source root",
    "docs/layout/diagram.png": "Not a template",
  });
  expect(result.candidates.map((value) => [value.kind, value.root])).toEqual([
    ["hexo-theme", "release/themes/first"],
    ["hexo-theme", "release/themes/second"],
  ]);
  expect(result.sourceDigest).toBe(source.digest);
  expect(result.source.files).toHaveLength(5);
  expect(source.tree.text("release/themes/first/scripts/config.js")).toContain("NEVER_EXECUTE");
});
test("Docusaurus sites, theme packages and unrelated React sources remain distinct without importing executable config", async () => {
  const { result } = await inspect({
    "site/package.json": JSON.stringify({ name: "example-site", dependencies: { "@docusaurus/core": "3.10.2" } }),
    "site/docusaurus.config.ts": "throw Error('Configuration must not execute');",
    "theme/package.json": JSON.stringify({
      name: "docusaurus-theme-example",
      peerDependencies: { "@docusaurus/core": "^3" },
    }),
    "theme/lib/theme/Layout/index.js": "export default function Layout() {}",
    "react/package.json": JSON.stringify({ name: "react-example", dependencies: { react: "18" } }),
    "react/theme/index.js": "export default {};",
  });
  expect(result.candidates.map((value) => [value.kind, value.name])).toEqual([
    ["docusaurus-site", "example-site"],
    ["docusaurus-theme", "docusaurus-theme-example"],
  ]);
  expect(result.issues).toEqual([]);
});
test("portable library recognition is separate from resource validation and malformed metadata has closed diagnostics", async () => {
  const { result } = await inspect({
    "library/panda-templates.json": JSON.stringify({
      schemaVersion: 1,
      kind: "panda-force.template-library",
      name: { en: "Example library" },
      entries: [],
    }),
    "broken/package.json": '{"DO_NOT_ECHO_METADATA":',
    "large/package.json": " ".repeat(256 * 1024 + 1),
  });
  expect(result.candidates).toEqual([
    { kind: "portable-library", root: "library", name: "Example library", evidence: ["library/panda-templates.json"] },
  ]);
  expect(result.issues).toEqual([
    { path: "broken/package.json", code: "metadataInvalid" },
    { path: "large/package.json", code: "metadataTooLarge" },
  ]);
  expect(JSON.stringify(result)).not.toContain("DO_NOT_ECHO_METADATA");
});
test("entry-only Docusaurus enhancement themes use captured module files without admitting generic plugins or missing entries", async () => {
  const { result } = await inspect({
    "enhancement/package.json": JSON.stringify({ name: "docusaurus-theme-notes", main: "./lib/start.cjs" }),
    "enhancement/lib/start.cjs": "throw Error('NEVER_EXECUTE');",
    "empty/package.json": JSON.stringify({ name: "docusaurus-theme-empty", main: "missing.js" }),
    "plugin/package.json": JSON.stringify({ name: "generic-plugin", main: "index.js", keywords: ["docusaurus"] }),
    "plugin/index.js": "throw Error('NEVER_EXECUTE');",
  });
  expect(result.candidates.map(({ kind, root, evidence }) => ({ kind, root, evidence }))).toEqual([
    {
      kind: "docusaurus-theme",
      root: "enhancement",
      evidence: ["enhancement/lib/start.cjs", "enhancement/package.json"],
    },
  ]);
  expect(result.issues).toEqual([]);
});
test("discovery limits candidate expansion independently of accepted source file storage", async () => {
  await expect(
    inspect(
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`theme-${i}/layout/index.ejs`, "<h1>Theme</h1>"])),
    ),
  ).rejects.toThrow("sourceTooLarge");
});
