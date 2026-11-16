import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { DEFAULT_SOURCE_LIMITS } from "../../src/shared/packages/sources/contracts.js";
import type { PackageSourceReader } from "../../src/shared/packages/sources/reader.js";
import { captureSourceSnapshot, CapturedPackageSource } from "../../src/shared/packages/sources/snapshot.js";
import { sourceInventory } from "../../src/shared/packages/sources/inventory.js";
import { sourceOrigin } from "../../src/shared/packages/sources/origin.js";
import { ImmutableSourceTree } from "../../src/shared/packages/sources/tree.js";
import { CapturedSourceCodec } from "../../src/server/packages/captures/codec.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";

const text = (value: string) => new TextEncoder().encode(value),
  blob = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const github = () => ({
  kind: "github" as const,
  repository: "https://github.com/example/templates",
  repositoryId: 42,
  requestedRef: "release/stable",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  root: "themes/company",
});
async function fixture() {
  const archive = zipSync({
      "theme/目录/layout.ejs": text("<h1>Original source</h1>"),
      "theme/picture.png": new Uint8Array([0, 255, 8]),
    }),
    reader = await openZipSource(archive, "company-theme.zip");
  return { archive, reader, snapshot: await captureSourceSnapshot(reader, undefined, archive) };
}
function editIndex(input: Uint8Array, edit: (index: Record<string, unknown>) => void) {
  const offset = 12 + new DataView(input.buffer, input.byteOffset).getUint32(8, false),
    index = JSON.parse(new TextDecoder().decode(input.subarray(12, offset)));
  edit(index);
  const json = text(JSON.stringify(index)),
    result = new Uint8Array(12 + json.length + input.length - offset);
  result.set(input.subarray(0, 8));
  new DataView(result.buffer).setUint32(8, json.length, false);
  result.set(json, 12);
  result.set(input.subarray(offset), 12 + json.length);
  return result;
}

test("captured ZIP snapshots retain the exact original and binary resources through a versioned byte roundtrip", async () => {
  const { archive, snapshot } = await fixture(),
    codec = new CapturedSourceCodec(),
    bytes = await codec.encode(snapshot),
    pending = codec.decode(bytes);
  bytes.fill(0);
  const restored = await pending;
  expect(restored.digest).toBe(snapshot.digest);
  expect(restored.descriptor).toEqual(snapshot.descriptor);
  expect(restored.readArchive()).toEqual(archive);
  restored.readArchive()!.fill(0);
  expect(restored.readArchive()).toEqual(archive);
  expect(restored.tree.text("theme/目录/layout.ejs")).toBe("<h1>Original source</h1>");
  expect(restored.tree.read("theme/picture.png")).toEqual(new Uint8Array([0, 255, 8]));
  expect(Object.isFrozen(restored.descriptor.inventory.files[0]!.integrity)).toBe(true);
  expect(snapshot.tree.digest).not.toBe(snapshot.digest);
});

test("selection captures a stable provider inventory before IO without fetching unavailable or unselected resources", async () => {
  const original = text("Pinned content"),
    unused = text("Unselected content"),
    origin = github(),
    files = [
      {
        path: "content.md",
        bytes: original.length,
        integrity: { algorithm: "git-blob-sha1" as const, value: blob(original) },
      },
      {
        path: "unused.md",
        bytes: unused.length,
        integrity: { algorithm: "git-blob-sha1" as const, value: blob(unused) },
      },
    ],
    unavailable = [{ path: "link", reason: "symlink" as const }],
    selected = ["content.md"],
    calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    reader: PackageSourceReader = {
      origin,
      files,
      unavailable,
      async read(path) {
        calls.push(path);
        await gate;
        return new Uint8Array(original);
      },
    },
    pending = captureSourceSnapshot(reader, selected);
  origin.commit = "c".repeat(40);
  files[0]!.integrity.value = "d".repeat(40);
  unavailable[0]!.path = "moved-link";
  selected[0] = "unused.md";
  release();
  const captured = await pending,
    codec = new CapturedSourceCodec(),
    restored = await codec.decode(await codec.encode(captured));
  expect(calls).toEqual(["content.md"]);
  expect(restored.descriptor.origin).toEqual(github());
  expect(restored.descriptor.inventory.files).toHaveLength(2);
  expect(restored.descriptor.inventory.unavailable).toEqual([{ path: "link", reason: "symlink" }]);
  expect(restored.tree.files.map((file) => file.path)).toEqual(["content.md"]);
  expect(restored.readArchive()).toBeUndefined();
  expect(() => restored.tree.read("unused.md")).toThrow("sourceUnavailable");
  expect(restored.tree.text("content.md")).toBe("Pinned content");
});

test("snapshot provenance rejects credential fields and inventories reject aliases across regular and unavailable nodes", () => {
  for (const extra of [
    { token: "SECRET" },
    { connectionId: "private-connection" },
    { headers: { authorization: "SECRET" } },
  ])
    expect(() => sourceOrigin({ ...github(), ...extra })).toThrow("invalidSource");
  for (const bad of ["../private", "A", "a/child"])
    expect(() =>
      sourceInventory({
        files: [{ path: "a", bytes: 0, integrity: { algorithm: "sha256", value: "a".repeat(64) } }],
        unavailable: [{ path: bad, reason: "gitlink" }],
      }),
    ).toThrow();
  expect(() => sourceOrigin({ ...github(), repository: "https://token@github.com/example/templates" })).toThrow(
    "invalidSource",
  );
});

test("snapshot readers detect changed headers, payloads, original archives and fabricated inventory hashes", async () => {
  const { snapshot } = await fixture(),
    codec = new CapturedSourceCodec(),
    original = await codec.encode(snapshot),
    payload = 12 + new DataView(original.buffer).getUint32(8, false);
  for (const offset of [0, payload, original.length - 1]) {
    const changed = new Uint8Array(original);
    changed[offset] = changed[offset]! ^ 1;
    await expect(codec.decode(changed)).rejects.toThrow();
  }
  await expect(codec.decode(original.subarray(0, original.length - 1))).rejects.toThrow("invalidSource");
  await expect(codec.decode(new Uint8Array([...original, 0]))).rejects.toThrow("invalidSource");
  await expect(
    codec.decode(
      editIndex(original, (index) => {
        index.treeDigest = "0".repeat(64);
      }),
    ),
  ).rejects.toThrow("sourceChanged");
  await expect(
    codec.decode(
      editIndex(original, (index) => {
        index.token = "SECRET";
      }),
    ),
  ).rejects.toThrow("sourceChanged");
  await expect(
    codec.decode(
      editIndex(original, (index) => {
        (index.inventory as { files: { integrity: { value: string } }[] }).files[0]!.integrity.value = "0".repeat(64);
      }),
    ),
  ).rejects.toThrow("sourceChanged");
});

test("snapshot storage limits preserve the distinction between intake resources and legacy execution quotas", async () => {
  const large = new Uint8Array(1024 * 1024 + 1).fill(65),
    archive = zipSync({ "theme/large.txt": large }),
    reader = await openZipSource(archive, "large.zip"),
    snapshot = await captureSourceSnapshot(reader, undefined, archive),
    codec = new CapturedSourceCodec();
  expect((await codec.decode(await codec.encode(snapshot))).tree.read("theme/large.txt")).toEqual(large);
  const small = { ...DEFAULT_SOURCE_LIMITS, fileBytes: 10, totalBytes: 10, archiveBytes: 10 };
  await expect(captureSourceSnapshot(reader, undefined, archive, small)).rejects.toThrow("sourceTooLarge");
  const { snapshot: normal } = await fixture();
  await expect(
    new CapturedSourceCodec({ ...DEFAULT_SOURCE_LIMITS, fileBytes: 1 }).decode(await codec.encode(normal)),
  ).rejects.toThrow("sourceTooLarge");
});

test("snapshot identity binds provenance and independent upstream hashes instead of trusting a claimed tree", async () => {
  const tree = await ImmutableSourceTree.create([{ path: "a", bytes: text("Retained") }]),
    inventory = {
      files: [
        { path: "a", bytes: 8, integrity: { algorithm: "git-blob-sha1" as const, value: blob(text("Retained")) } },
      ],
      unavailable: [],
    },
    first = await CapturedPackageSource.create(github(), inventory, tree),
    second = await CapturedPackageSource.create({ ...github(), requestedRef: "new-release" }, inventory, tree);
  expect(first.tree.digest).toBe(second.tree.digest);
  expect(first.digest).not.toBe(second.digest);
  await expect(
    CapturedPackageSource.create(
      github(),
      {
        ...inventory,
        files: [{ ...inventory.files[0]!, integrity: { algorithm: "git-blob-sha1", value: "0".repeat(40) } }],
      },
      tree,
    ),
  ).rejects.toThrow("sourceChanged");
  await expect(CapturedPackageSource.create(github(), inventory, tree, new Uint8Array())).rejects.toThrow(
    "invalidSource",
  );
});
