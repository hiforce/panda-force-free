import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { linkedSource, linkedSourceReader, sourceText } from "../support/linked-source.js";
import { captureLinkedSourceSnapshot } from "../../src/shared/packages/sources/linked-capture.js";
import { captureSourceSnapshot, CapturedPackageSource } from "../../src/shared/packages/sources/snapshot.js";
import { projectSourceAliases } from "../../src/shared/packages/sources/aliases.js";
import { DEFAULT_SOURCE_LIMITS } from "../../src/shared/packages/sources/contracts.js";
import { CapturedSourceCodec } from "../../src/server/packages/captures/codec.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";

test("linked sources preserve original targets independently from a complete bounded projection", async () => {
  const source = await linkedSource(
    { "theme/languages/en.yml": "title: Hello", "theme/logo.png": new Uint8Array([0, 255, 9]) },
    {
      "theme/languages/default.yml": "en.yml",
      "theme/languages/en-US.yml": "./default.yml",
      "theme/images": "./assets",
      "theme/assets/logo": "../logo.png",
    },
  );
  const projected = await projectSourceAliases(source, "theme");
  expect(projected.tree.text("languages/default.yml")).toBe("title: Hello");
  expect(projected.tree.text("languages/en-US.yml")).toBe("title: Hello");
  expect(projected.tree.read("images/logo")).toEqual(new Uint8Array([0, 255, 9]));
  expect(source.tree.has("theme/languages/default.yml")).toBe(false);
  expect(source.links!.text("theme/languages/default.yml")).toBe("en.yml");
  expect(projected.descriptor.sourceDigest).toBe(source.digest);
  expect(projected.tree.digest).not.toBe(source.tree.digest);
  expect((await projectSourceAliases(source, "theme")).digest).toBe(projected.digest);
});

test("directory aliases resolve through alias prefixes and duplicate binary resources as owned copies", async () => {
  const source = await linkedSource(
    { "assets/icons/logo.bin": new Uint8Array([1, 2, 3]) },
    { images: "assets/", brand: "images/icons", logo: "brand/logo.bin" },
  );
  const { tree } = await projectSourceAliases(source);
  expect(tree.files.map((file) => file.path)).toEqual([
    "assets/icons/logo.bin",
    "brand/logo.bin",
    "images/icons/logo.bin",
    "logo",
  ]);
  const bytes = tree.read("logo");
  bytes.fill(0);
  expect(tree.read("brand/logo.bin")).toEqual(new Uint8Array([1, 2, 3]));
  expect(source.tree.read("assets/icons/logo.bin")).toEqual(new Uint8Array([1, 2, 3]));
});

test("selected-root resolution rejects escapes, absolute targets and malformed logical paths", async () => {
  for (const target of [
    "../private",
    "/etc/passwd",
    "C:/private",
    "..\\private",
    "a/%2e%2e/private",
    "\u0000secret",
    "\ufeffok",
    "foo\nbar",
  ]) {
    const source = await linkedSource({ private: "Do not read", "theme/ok": "Visible" }, { "theme/alias": target });
    await expect(projectSourceAliases(source, "theme")).rejects.toThrow("invalidSourcePath");
    expect(source.links!.read("theme/alias")).toEqual(sourceText(target));
  }
  const malformed = await linkedSource({ ok: "Visible" }, { alias: new Uint8Array([255]) });
  await expect(projectSourceAliases(malformed)).rejects.toThrow("invalidSource");
});

test("cycles, ancestor aliases, dangling targets and case aliases cannot generate partial projections", async () => {
  const cycles: Record<string, string>[] = [
    { a: "b", b: "a" },
    { "dir/up": ".." },
    { "dir/self": "." },
    { a: "a/child" },
  ];
  for (const targets of cycles) {
    const source = await linkedSource({ "dir/value": "Kept" }, targets);
    await expect(projectSourceAliases(source)).rejects.toThrow("invalidSource");
  }
  for (const target of ["missing", "DIR/value"])
    await expect(projectSourceAliases(await linkedSource({ "dir/value": "Kept" }, { a: target }))).rejects.toThrow(
      "sourceUnavailable",
    );
  await expect(linkedSource({ "A/file": "Original" }, { "a/alias": "file" })).rejects.toThrow("duplicateSourcePath");
});

test("projection budgets cover expanded file count, directories, bytes, depth and caller cancellation", async () => {
  const source = await linkedSource({ "assets/icon": "Large" }, { a: "assets", b: "a" });
  for (const options of [{ files: 2 }, { entries: 3 }, { totalBytes: 10 }, { fileBytes: 4 }])
    await expect(projectSourceAliases(source, "", { ...DEFAULT_SOURCE_LIMITS, ...options })).rejects.toThrow(
      "sourceTooLarge",
    );
  const targets = Object.fromEntries(
    Array.from({ length: 70 }, (_, i) => ["alias" + i, i === 69 ? "value" : "alias" + (i + 1)]),
  );
  await expect(projectSourceAliases(await linkedSource({ value: "Kept" }, targets))).rejects.toThrow("sourceTooLarge");
  const controller = new AbortController();
  controller.abort();
  await expect(projectSourceAliases(source, "", undefined, controller.signal)).rejects.toThrow("sourceCancelled");
});

test("versioned raw snapshots roundtrip binary targets without altering v1 identities or accepting forged metadata", async () => {
  const reader = linkedSourceReader({ file: "Hello" }, { alias: "file" }),
    codec = new CapturedSourceCodec();
  await expect(captureSourceSnapshot(reader)).rejects.toThrow("unsupportedSourceEntry");
  const legacy = await captureSourceSnapshot(reader, ["file"]),
    source = await captureLinkedSourceSnapshot(reader),
    encoded = await codec.encode(source),
    restored = await codec.decode(encoded);
  expect(legacy.descriptor.schema).toBe("panda.package-source/v1");
  expect((await codec.decode(await codec.encode(legacy))).digest).toBe(legacy.digest);
  expect(restored.descriptor.schema).toBe("panda.package-source/v2");
  expect(restored.digest).toBe(source.digest);
  expect(restored.links!.text("alias")).toBe("file");
  expect(restored.tree.has("alias")).toBe(false);
  const corrupt = new Uint8Array(encoded);
  corrupt[corrupt.length - 1] = 0;
  await expect(codec.decode(corrupt)).rejects.toThrow("sourceChanged");
  await expect(
    CapturedPackageSource.createLinked(reader.origin, reader, source.tree, [], source.links!),
  ).rejects.toThrow("invalidSource");
  const selection = await captureLinkedSourceSnapshot(reader, ["file"]);
  await expect(projectSourceAliases(selection)).rejects.toThrow("unsupportedSourceEntry");
});

test("explicit linked ZIP intake keeps original archive bytes and default ZIP intake stays strict", async () => {
  const archive = zipSync({
      "theme/en.yml": sourceText("hello"),
      "theme/default.yml": [sourceText("en.yml"), { os: 3, attrs: 0xa1ff0000 }],
    }),
    reader = await openZipSource(archive, "theme.zip", undefined, undefined, "logical-links/v2"),
    source = await captureLinkedSourceSnapshot(reader, undefined, archive),
    codec = new CapturedSourceCodec();
  await expect(openZipSource(archive, "theme.zip")).rejects.toThrow("unsupportedArchive");
  const restored = await codec.decode(await codec.encode(source));
  expect(restored.readArchive()).toEqual(archive);
  expect((await projectSourceAliases(restored, "theme")).tree.text("default.yml")).toBe("hello");
});
