import { expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { nativeFiles, nativeSettings, nativeZipSource } from "../support/native-theme.js";
import { NativeSiteTheme } from "../../src/shared/templates/native/package.js";
import { exportNativeTheme } from "../../src/server/templates/native/export.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { readNativeThemeBundle, NATIVE_THEME_BUNDLE_FILE } from "../../src/shared/templates/native/bundle.js";
import { discoverTemplateSource } from "../../src/server/templates/sources/discovery.js";
import { linkedSource } from "../support/linked-source.js";

async function exported(engine: "hexo" | "docusaurus" = "hexo") {
  const { source } = await nativeZipSource({
      ...nativeFiles,
      "theme/index.js": "module.exports=()=>({name:'bundle'});",
    }),
    original = await NativeSiteTheme.create(source, "theme", {
      ...nativeSettings(),
      engine,
      name: { en: "Company theme", "zh-CN": "公司主题" },
      entry: engine === "hexo" ? null : "index.js",
    }),
    value = await exportNativeTheme(original);
  return { original, value, files: unzipSync(value.bytes) };
}

test("native export materializes accepted source aliases as regular bytes that the strict ZIP importer can reopen", async () => {
  const source = await linkedSource(nativeFiles, { "theme/source/alias.bin": "logo.bin" }),
    original = await NativeSiteTheme.create(source, "theme", nativeSettings()),
    value = await exportNativeTheme(original),
    imported = await captureSourceSnapshot(await openZipSource(value.bytes, value.filename), undefined, value.bytes),
    settings = readNativeThemeBundle(imported, "theme")!.settings,
    restored = await NativeSiteTheme.create(imported, "theme", settings);
  expect(imported.tree.read("theme/source/alias.bin")).toEqual(new Uint8Array([0, 10, 255]));
  expect(imported.links).toBeUndefined();
  expect(restored.projection.tree.digest).toBe(original.projection.tree.digest);
  expect(imported.tree.has("private.txt")).toBe(false);
});

test("native source export rejects a full source inventory instead of silently dropping files to fit bundle metadata", async () => {
  const files: Record<string, string | Uint8Array> = { ...nativeFiles };
  delete files["private.txt"];
  for (let i = 0; i < 4092; i++) files[`theme/source/resource-${i}.txt`] = "resource";
  const { source } = await nativeZipSource(files),
    theme = await NativeSiteTheme.create(source, "theme", nativeSettings());
  await expect(exportNativeTheme(theme)).rejects.toThrow("exportTooLarge");
});

for (const engine of ["hexo", "docusaurus"] as const)
  test(
    "native source ZIP preserves effective binary code and metadata without leaking unrelated originals: " + engine,
    async () => {
      const { original, value, files } = await exported(engine);
      expect(Object.keys(files).sort()).toEqual(
        [
          NATIVE_THEME_BUNDLE_FILE,
          "notices/LICENSE",
          "notices/README.md",
          "theme/index.js",
          "theme/layout/index.ejs",
          "theme/source/logo.bin",
        ].sort(),
      );
      expect(files["theme/source/logo.bin"]).toEqual(new Uint8Array([0, 10, 255]));
      const reader = await openZipSource(value.bytes, value.filename),
        source = await captureSourceSnapshot(reader, undefined, value.bytes),
        restored = readNativeThemeBundle(source, "theme")!;
      expect(restored.settings).toEqual({
        ...original.descriptor.data.settings,
        license: { expression: "MIT", file: "notices/LICENSE" },
        readme: "notices/README.md",
      });
      const copy = await NativeSiteTheme.create(source, "theme", restored.settings);
      expect(copy.projection.tree.digest).toBe(original.projection.tree.digest);
      expect(copy.digest).not.toBe(original.digest);
      expect(copy.descriptor.data.source.origin.kind).toBe("zip-upload");
      expect(copy.descriptor.data.source.digest).toBe(source.digest);
      expect(source.tree.text("notices/LICENSE")).toBe("MIT fixture license");
      expect(source.tree.text("notices/README.md")).toBe("Native theme usage");
      const manifest = source.tree.text(NATIVE_THEME_BUNDLE_FILE);
      expect(manifest).not.toContain("Owner-only original resource");
      expect(manifest).not.toContain("approval");
      expect(manifest).not.toContain("origin");
      expect((await exportNativeTheme(original)).bytes).toEqual(value.bytes);
    },
  );

test("repository wrappers retain bundle defaults without admitting unrelated files into execution or re-export", async () => {
  const { files } = await exported("docusaurus"),
    prefix = "library/company/",
    wrapper = await nativeZipSource({
      ...Object.fromEntries(Object.entries(files).map(([path, bytes]) => [prefix + path, bytes])),
      "README.md": "Private collection notes",
      "library/company/private.txt": "PRIVATE_COLLECTION_DATA",
    }),
    root = prefix + "theme",
    restored = readNativeThemeBundle(wrapper.source, root)!;
  expect(restored.settings.name["zh-CN"]).toBe("公司主题");
  const discoveries = await discoverTemplateSource(wrapper.source);
  expect(discoveries.candidates.some((value) => value.kind === "docusaurus-theme" && value.root === root)).toBe(true);
  const value = await exportNativeTheme(await NativeSiteTheme.create(wrapper.source, root, restored.settings));
  expect(Object.keys(unzipSync(value.bytes)).some((path) => path.includes("private"))).toBe(false);
});

test("a closed bundle cannot add executable aliases omitted from its regular-file manifest", async () => {
  const { files } = await exported(),
    source = await linkedSource(files, { "theme/source/unlisted.bin": "logo.bin" });
  await expect(
    NativeSiteTheme.create(source, "theme", {
      ...nativeSettings(),
      license: { expression: "MIT", file: "notices/LICENSE" },
      readme: "notices/README.md",
    }),
  ).rejects.toThrow("invalidInput");
});

for (const change of ["image-bytes", "license-bytes", "unlisted-code", "extra-grant", "missing-file"] as const)
  test("bundle admission rejects " + change + " even when a caller bypasses the proposal form", async () => {
    const { files } = await exported();
    if (change === "image-bytes") files["theme/source/logo.bin"] = new Uint8Array([1, 2, 3]);
    if (change === "license-bytes") files["notices/LICENSE"] = new TextEncoder().encode("Substituted license");
    if (change === "unlisted-code") files["theme/extra.js"] = new TextEncoder().encode("CODE_NOT_DECLARED");
    if (change === "missing-file") delete files["theme/layout/index.ejs"];
    if (change === "extra-grant") {
      const manifest = JSON.parse(new TextDecoder().decode(files[NATIVE_THEME_BUNDLE_FILE]));
      manifest.approval = { permissions: ["build:theme-code"] };
      files[NATIVE_THEME_BUNDLE_FILE] = new TextEncoder().encode(JSON.stringify(manifest));
    }
    const { source } = await nativeZipSource(files);
    await expect(NativeSiteTheme.create(source, "theme", nativeSettings())).rejects.toThrow("invalidInput");
  });
