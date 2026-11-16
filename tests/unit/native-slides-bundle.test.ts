import { expect, test } from "bun:test";
import { NativeSlidesTemplate } from "../../src/server/slides/templates/model.js";
import { readNativeSlidesBundle, captureNativeSlidesBundle } from "../../src/server/slides/templates/bundle.js";
import { nativeSlidesOriginal } from "../../src/server/slides/templates/source.js";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { DEFAULT_SOURCE_LIMITS } from "../../src/shared/packages/sources/contracts.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { writeSourceZip } from "../../src/server/packages/zip/write.js";
import { nativeSlidesFixture } from "../support/native-slides.js";

test("native template bundles retain exact Office source, mapping bytes and notices across export and reimport", async () => {
  const f = await nativeSlidesFixture(),
    mapping = new TextEncoder().encode(JSON.stringify(f.mapping, null, 2) + "\n"),
    value = await NativeSlidesTemplate.fromFiles(
      f.original,
      f.settings,
      mapping,
      new TextEncoder().encode(f.license),
      new TextEncoder().encode(f.readme),
    ),
    source = await captureNativeSlidesBundle(value),
    restored = await readNativeSlidesBundle(source.tree);
  expect(restored.digest).toBe(value.digest);
  expect(restored.original()).toEqual(f.original);
  expect(restored.files.read("mapping.json")).toEqual(mapping);
  expect(restored.files.text("LICENSE")).toBe(f.license);
  expect(restored.files.text("README.md")).toBe(f.readme);
  expect(restored.mapping).toEqual(f.mapping);
  expect(restored.presentation.index.layouts).toEqual(f.presentation.index.layouts);
  expect((await restored.export()).bytes).toEqual((await value.export()).bytes);
  restored.original().fill(0);
  expect(restored.original()).toEqual(f.original);
});

test("raw Office uploads and selected library files return the Office original, never the enclosing library ZIP", async () => {
  const f = await nativeSlidesFixture(),
    raw = await captureSourceSnapshot(await openZipSource(f.original, "source.potx"), undefined, f.original),
    libraryBytes = await writeSourceZip([
      { path: "decks/title.potx", bytes: f.original },
      { path: "private.txt", bytes: new TextEncoder().encode("Unselected private file") },
    ]),
    library = await captureSourceSnapshot(await openZipSource(libraryBytes, "library.zip"), undefined, libraryBytes);
  expect(nativeSlidesOriginal(raw, { kind: "archive" })).toEqual(f.original);
  expect(nativeSlidesOriginal(library, { kind: "file", path: "decks/title.potx" })).toEqual(f.original);
  expect(() => nativeSlidesOriginal(library, { kind: "file", path: "../private.txt" })).toThrow("invalidInput");
  const exported = await captureNativeSlidesBundle(f.template);
  expect(exported.tree.has("private.txt")).toBe(false);
});

test("a native bundle can be selected from a mixed library without exporting unrelated templates", async () => {
  const f = await nativeSlidesFixture(),
    source = await captureNativeSlidesBundle(f.template),
    tree = await ImmutableSourceTree.create([
      ...source.tree.files.map((file) => ({ path: "templates/deck/" + file.path, bytes: source.tree.read(file.path) })),
      { path: "templates/unrelated/private.txt", bytes: new TextEncoder().encode("Not selected") },
    ]),
    restored = await readNativeSlidesBundle(tree, "templates/deck");
  expect(restored.digest).toBe(f.template.digest);
  expect(restored.files.files.map((file) => file.path)).not.toContain("templates/unrelated/private.txt");
});

test("tampered files, stale mappings and imported owner or permission fields are rejected", async () => {
  const f = await nativeSlidesFixture(),
    source = await captureNativeSlidesBundle(f.template),
    base = source.tree,
    manifest = JSON.parse(base.text("panda-slides.json"));
  const replace = (path: string, bytes: Uint8Array) =>
    ImmutableSourceTree.create(
      base.files.map((file) => ({ path: file.path, bytes: file.path === path ? bytes : base.read(file.path) })),
    );
  const bytes = base.read("original.potx");
  bytes[10] = bytes[10]! ^ 1;
  await expect(readNativeSlidesBundle(await replace("original.potx", bytes))).rejects.toMatchObject({
    code: "sourceChanged",
  });
  for (const field of ["owner", "permissions", "receipt"])
    await expect(
      readNativeSlidesBundle(
        await replace(
          "panda-slides.json",
          new TextEncoder().encode(JSON.stringify({ ...manifest, [field]: "old authority" })),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalidBundle" });
  await expect(
    NativeSlidesTemplate.create(f.original, f.settings, { ...f.mapping, sourceSha256: "0".repeat(64) }, f.license),
  ).rejects.toMatchObject({ code: "invalidMapping" });
});

test("template inputs are captured before asynchronous parsing and versions have distinct immutable identities", async () => {
  const f = await nativeSlidesFixture(),
    original = new Uint8Array(f.original),
    settings = { ...f.settings, name: { ...f.settings.name } },
    mapping = structuredClone(f.mapping),
    pending = NativeSlidesTemplate.create(original, settings, mapping, f.license, f.readme);
  original.fill(0);
  settings.name.en = "Later name";
  mapping.slots[0]!.label = "Later label";
  const value = await pending,
    next = await nativeSlidesFixture("2.0.0");
  expect(value.original()).toEqual(f.original);
  expect(value.manifest.settings.name.en).toBe(f.settings.name.en);
  expect(value.mapping.slots[0]!.label).toBe("Title");
  expect(value.digest).toBe(f.template.digest);
  expect(value.digest).not.toBe(next.template.digest);
});

test("ZIP export validates paths, bounds and mutable input before starting its writer", async () => {
  const bytes = new Uint8Array([1, 2, 3]),
    pending = writeSourceZip([{ path: "original.bin", bytes }]);
  bytes.fill(0);
  const archive = await pending,
    reader = await openZipSource(archive, "regular.zip");
  expect(await reader.read("original.bin")).toEqual(new Uint8Array([1, 2, 3]));
  await expect(writeSourceZip([{ path: "../escape", bytes }])).rejects.toMatchObject({ code: "invalidSourcePath" });
  await expect(
    writeSourceZip([
      { path: "same", bytes },
      { path: "SAME", bytes },
    ]),
  ).rejects.toMatchObject({ code: "duplicateSourcePath" });
  await expect(
    writeSourceZip([{ path: "large", bytes: new Uint8Array([1, 2, 3]) }], { ...DEFAULT_SOURCE_LIMITS, totalBytes: 2 }),
  ).rejects.toMatchObject({ code: "sourceTooLarge" });
});

test("creation and reimport share the same manifest byte budget", async () => {
  const f = await nativeSlidesFixture(),
    name: Record<string, string> = { en: "Original" };
  for (let i = 0; i < 26; i++) name["q" + String.fromCharCode(97 + i)] = "字".repeat(2000);
  await expect(
    NativeSlidesTemplate.create(f.original, { ...f.settings, name }, f.mapping, f.license),
  ).rejects.toMatchObject({ code: "limitExceeded" });
});
