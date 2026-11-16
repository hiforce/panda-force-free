import { expect, test } from "bun:test";
import { NativeSiteTheme } from "../../src/shared/templates/native/package.js";
import { NativeThemeDescriptor } from "../../src/shared/templates/native/descriptor.js";
import { nativeThemeSettings } from "../../src/shared/templates/native/settings.js";
import { captureLinkedSourceSnapshot } from "../../src/shared/packages/sources/linked-capture.js";
import { nativeSettings, nativeFiles, nativeZipSource } from "../support/native-theme.js";
import { linkedSource, linkedSourceReader } from "../support/linked-source.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";
import { resourceBuildBase } from "../support/resource-build.js";

test("native theme definitions retain original sources and license separately from executable alias projections", async () => {
  const source = await linkedSource(nativeFiles, { "theme/source/alias.bin": "logo.bin" }),
    theme = await NativeSiteTheme.create(source, "theme", nativeSettings());
  expect(theme.source).toBe(source);
  expect(theme.descriptor.data.source.origin).toEqual(source.descriptor.origin);
  expect(theme.projection.tree.read("source/alias.bin")).toEqual(new Uint8Array([0, 10, 255]));
  expect(theme.source.links!.text("theme/source/alias.bin", 100)).toBe("logo.bin");
  expect(theme.source.tree.text("private.txt", 100)).toBe("Owner-only original resource");
  expect(theme.projection.tree.has("private.txt")).toBe(false);
  expect(theme.descriptor.data.license.path).toBe("LICENSE");
  expect(Object.isFrozen(theme.descriptor.data.settings.dependencies)).toBe(true);
  const request = await ResourceBuildRequest.create(resourceBuildBase(), theme.definition(), theme.projection.tree);
  expect(request.descriptor.theme.source.digest).toBe(source.digest);
  expect(request.descriptor.theme.source.projectionDigest).toBe(theme.projection.digest);
});

test("native roots require complete regular and linked files without reaching outside the selected theme", async () => {
  const reader = linkedSourceReader(nativeFiles, { "theme/source/alias.bin": "logo.bin" }),
    partial = await captureLinkedSourceSnapshot(reader, [
      "LICENSE",
      "README.md",
      "theme/layout/index.ejs",
      "theme/source/alias.bin",
    ]);
  await expect(NativeSiteTheme.create(partial, "theme", nativeSettings())).rejects.toThrow("incompleteSource");
  const escape = await linkedSource(nativeFiles, { "theme/source/escape": "../../private.txt" });
  await expect(NativeSiteTheme.create(escape, "theme", nativeSettings())).rejects.toThrow();
  const missingLicense = await nativeZipSource({ "theme/layout/index.ejs": "<h1>Missing license</h1>" });
  await expect(NativeSiteTheme.create(missingLicense.source, "theme", nativeSettings())).rejects.toThrow(
    "invalidInput",
  );
  const incompleteLinks = await captureLinkedSourceSnapshot(reader, Object.keys(nativeFiles));
  await expect(NativeSiteTheme.create(incompleteLinks, "theme", nativeSettings())).rejects.toThrow();
});

test("native resources are not reduced to historical portable package file and byte limits", async () => {
  const files: Record<string, string | Uint8Array> = {
    ...nativeFiles,
    "theme/source/large.bin": new Uint8Array(8 * 1024 * 1024 + 1).fill(17),
  };
  for (let i = 0; i < 520; i++) files[`theme/source/empty-${i}`] = "";
  const { source } = await nativeZipSource(files),
    theme = await NativeSiteTheme.create(source, "theme", nativeSettings());
  expect(theme.projection.tree.files.length).toBeGreaterThan(512);
  expect(theme.projection.tree.read("source/large.bin").length).toBe(8 * 1024 * 1024 + 1);
});

test("native metadata rejects hidden execution instructions, ranges, invalid provenance and forged resource inventories", async () => {
  for (const change of [
    { image: "untrusted/image" },
    { dependencies: { tool: "latest" } },
    { entry: "index.js" },
    { license: { expression: "MIT", file: "../LICENSE" } },
  ])
    expect(() => nativeThemeSettings({ ...nativeSettings(), ...change })).toThrow("invalidInput");
  const { source } = await nativeZipSource(),
    value = await NativeSiteTheme.create(source, "theme", nativeSettings());
  for (const change of [
    { root: "other" },
    { projection: { ...value.descriptor.data.projection, treeDigest: "0".repeat(64) } },
    {
      projection: {
        ...value.descriptor.data.projection,
        files: value.descriptor.data.projection.files.map((file) => ({ ...file, bytes: String(file.bytes) })),
      },
    },
    { source: { digest: source.digest, origin: { ...source.descriptor.origin, credentials: "private" } } },
  ])
    await expect(NativeThemeDescriptor.create({ ...value.descriptor.data, ...change })).rejects.toThrow("invalidInput");
  const docusaurus = await nativeZipSource({
      ...nativeFiles,
      "theme/index.js": "module.exports = () => ({ name: 'fixture' });",
    }),
    settings = { ...nativeSettings(), engine: "docusaurus", entry: "index.js" };
  expect((await NativeSiteTheme.create(docusaurus.source, "theme", settings)).definition().entry).toBe("index.js");
  await expect(NativeSiteTheme.create(source, "theme", settings)).rejects.toThrow("invalidInput");
});
