import { expect, test } from "bun:test";
import { zipSync, Zip, ZipPassThrough } from "fflate";
import { crc32, inflateRaw } from "node:zlib";
import { DEFAULT_SOURCE_LIMITS, SourceError } from "../../src/shared/packages/sources/contracts.js";
import { readSourceZip } from "../../src/server/packages/zip/read.js";

const text = (value: string) => new TextEncoder().encode(value);
const zip = () =>
  zipSync({
    "repository/目录/layout/index.ejs": text("<h1>Native source</h1>"),
    "repository/asset.png": new Uint8Array([0, 255, 4]),
  });
function headers(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    end = bytes.length - 22;
  const first = view.getUint32(end + 16, true),
    name = view.getUint16(first + 28, true),
    extra = view.getUint16(first + 30, true),
    comment = view.getUint16(first + 32, true);
  return { view, first, second: first + 46 + name + extra + comment, local: view.getUint32(first + 42, true) };
}

test("ZIP acquisition retains exact source filenames and bytes without interpreting theme scripts", async () => {
  const bytes = zip(),
    pending = readSourceZip(bytes);
  bytes.fill(0);
  const tree = await pending;
  expect(tree.text("repository/目录/layout/index.ejs")).toBe("<h1>Native source</h1>");
  expect(tree.read("repository/asset.png")).toEqual(new Uint8Array([0, 255, 4]));
  expect(tree.files.length).toBe(2);
  expect(tree.byteLength).toBe(text("<h1>Native source</h1>").length + 3);
  expect(tree.digest).toBe((await readSourceZip(zip())).digest);
});

test("streamed ZIP data descriptors and explicit parent directories decode to the same source tree", async () => {
  const chunks: Uint8Array[] = [],
    archive = new Zip((error, bytes) => {
      if (error) throw error;
      chunks.push(bytes);
    });
  const directory = new ZipPassThrough("repository/");
  archive.add(directory);
  directory.push(new Uint8Array(), true);
  const file = new ZipPassThrough("repository/content.md");
  archive.add(file);
  file.push(text("Retained "), false);
  file.push(text("bytes"), true);
  archive.end();
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  expect((await readSourceZip(bytes)).text("repository/content.md")).toBe("Retained bytes");
});

test("an unsigned descriptor whose CRC equals the optional signature retains its original bytes", async () => {
  const content = new Uint8Array([172, 10, 122, 213]);
  expect(crc32(content)).toBe(0x08074b50);
  const chunks: Uint8Array[] = [],
    archive = new Zip((error, bytes) => {
      if (error) throw error;
      chunks.push(bytes);
    });
  const file = new ZipPassThrough("collision.bin");
  archive.add(file);
  file.push(content, true);
  archive.end();
  const original = new Uint8Array(chunks.flatMap((bytes) => [...bytes])),
    meta = headers(original);
  const descriptor = meta.first - 16;
  expect(meta.view.getUint32(descriptor, true)).toBe(0x08074b50);
  const unsigned = new Uint8Array(original.length - 4);
  unsigned.set(original.subarray(0, descriptor));
  unsigned.set(original.subarray(descriptor + 4), descriptor);
  new DataView(unsigned.buffer).setUint32(unsigned.length - 22 + 16, meta.first - 4, true);
  expect((await readSourceZip(unsigned)).read("collision.bin")).toEqual(content);
});

test("central Unicode path metadata remains bound to raw local names when local Unicode extras are absent", async () => {
  const original = zipSync({ "legacy.txt": text("Exact source") }),
    meta = headers(original),
    raw = text("legacy.txt"),
    unicode = text("文档.txt"),
    extra = new Uint8Array(9 + unicode.length),
    fields = new DataView(extra.buffer);
  fields.setUint16(0, 0x7075, true);
  fields.setUint16(2, 5 + unicode.length, true);
  extra[4] = 1;
  fields.setUint32(5, crc32(raw), true);
  extra.set(unicode, 9);
  const start = meta.first + 46 + raw.length,
    combined = new Uint8Array(original.length + extra.length);
  combined.set(original.subarray(0, start));
  combined.set(extra, start);
  combined.set(original.subarray(start), start + extra.length);
  const updated = new DataView(combined.buffer);
  updated.setUint16(meta.first + 30, extra.length, true);
  updated.setUint32(
    combined.length - 22 + 12,
    meta.view.getUint32(original.length - 22 + 12, true) + extra.length,
    true,
  );
  expect((await readSourceZip(combined)).text("文档.txt")).toBe("Exact source");
  combined[start + 5] ^= 1;
  await expect(readSourceZip(combined)).rejects.toThrow("invalidArchive");
});

test("ZIP intake rejects symlinks, encryption, local-header disagreement, duplicate offsets and trailing data", async () => {
  const link = zip();
  headers(link).view.setUint32(headers(link).first + 38, 0xa1ff0000, true);
  await expect(readSourceZip(link)).rejects.toThrow("unsupportedArchive");
  const encrypted = zip(),
    enc = headers(encrypted);
  enc.view.setUint16(enc.first + 8, enc.view.getUint16(enc.first + 8, true) | 1, true);
  await expect(readSourceZip(encrypted)).rejects.toThrow("unsupportedArchive");
  const mismatch = zip(),
    changed = headers(mismatch);
  changed.view.setUint16(changed.local + 8, 0, true);
  await expect(readSourceZip(mismatch)).rejects.toThrow("invalidArchive");
  const overlap = zip(),
    overlapping = headers(overlap);
  overlapping.view.setUint32(overlapping.second + 42, overlapping.local, true);
  await expect(readSourceZip(overlap)).rejects.toThrow("invalidArchive");
  const extra = new Uint8Array(zip().length + 1);
  extra.set(zip());
  await expect(readSourceZip(extra)).rejects.toThrow("invalidArchive");
});

test("ZIP paths reject parent traversal, case-folded aliases and file-directory collisions", async () => {
  const examples: Record<string, Uint8Array>[] = [
    { "../escape": text("x") },
    { "a/x": text("x"), "A/y": text("y") },
    { a: text("x"), "a/b": text("y") },
    { "\uFEFFhidden.txt": text("x") },
  ];
  for (const files of examples) await expect(readSourceZip(zipSync(files))).rejects.toThrow(SourceError);
});

test("CRC and declared expansion checks reject changed bytes and forged compressed sizes", async () => {
  const damaged = zipSync({ "a.txt": [text("Original"), { level: 0 }] }),
    changed = headers(damaged);
  const payload =
    changed.local +
    30 +
    changed.view.getUint16(changed.local + 26, true) +
    changed.view.getUint16(changed.local + 28, true);
  damaged[payload] ^= 1;
  await expect(readSourceZip(damaged)).rejects.toThrow("invalidArchive");
  const bomb = zipSync({ "bomb.txt": new Uint8Array(8 * 1024 * 1024) }),
    forged = headers(bomb);
  forged.view.setUint32(forged.first + 24, 1, true);
  forged.view.setUint32(forged.local + 22, 1, true);
  await expect(readSourceZip(bomb, { ...DEFAULT_SOURCE_LIMITS, fileBytes: 1024, totalBytes: 1024 })).rejects.toThrow(
    "invalidArchive",
  );
  await new Promise<void>((resolve, reject) => {
    const packedStart =
        forged.local +
        30 +
        forged.view.getUint16(forged.local + 26, true) +
        forged.view.getUint16(forged.local + 28, true),
      packedSize = forged.view.getUint32(forged.local + 18, true);
    inflateRaw(bomb.subarray(packedStart, packedStart + packedSize), { maxOutputLength: 2 }, (error, output) => {
      try {
        expect(error).toBeTruthy();
        expect(output).toBeUndefined();
        resolve();
      } catch (failure) {
        reject(failure);
      }
    });
  });
});

test("ZIP counts, per-file and aggregate expansion are bounded before the first decode", async () => {
  await expect(readSourceZip(zip(), { ...DEFAULT_SOURCE_LIMITS, files: 1 })).rejects.toThrow("sourceTooLarge");
  await expect(readSourceZip(zip(), { ...DEFAULT_SOURCE_LIMITS, fileBytes: 3 })).rejects.toThrow("sourceTooLarge");
  await expect(readSourceZip(zip(), { ...DEFAULT_SOURCE_LIMITS, totalBytes: 3 })).rejects.toThrow("sourceTooLarge");
  const controller = new AbortController();
  controller.abort();
  await expect(readSourceZip(zip(), undefined, controller.signal)).rejects.toThrow("sourceCancelled");
  await expect(readSourceZip(new Uint8Array([0]))).rejects.toThrow("invalidArchive");
});
