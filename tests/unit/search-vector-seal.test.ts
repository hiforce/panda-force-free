import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectorChunks, vectorRowDigest, float32Vector } from "../../src/server/search/providers/vector-rows.js";
import { VectorSealStore } from "../../src/server/search/providers/vector-seal.js";
test("float32 row digests survive REST decimal rounding and bind every chunk field", () => {
  const row = {
      id: "a".repeat(64),
      knowledge: "knowledge",
      version: "v1",
      start: 0,
      text: "Saved",
      vector: [0.1, 0.2, 0.3, 0.4],
    },
    digest = vectorRowDigest(row, 4);
  expect(vectorRowDigest({ ...row, vector: row.vector.map(Math.fround) }, 4)).toBe(digest);
  for (const changed of [
    { text: "Other" },
    { knowledge: "Other" },
    { version: "v2" },
    { start: 1 },
    { vector: [0.4, 0.3, 0.2, 0.1] },
  ])
    expect(vectorRowDigest({ ...row, ...changed }, 4)).not.toBe(digest);
  for (const vector of [
    [0, 0, 0, 0],
    [1e100, 0, 0, 0],
    [1e-100, 0, 0, 0],
    [NaN, 0, 0, 0],
  ])
    expect(() => float32Vector(vector, 4)).toThrow();
  const chunks = vectorChunks([{ id: "knowledge", version: "v1", title: "Title", text: "😀".repeat(1800) }]);
  expect(chunks.length).toBe(2);
  expect(
    chunks.every((c) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(c.text)),
  ).toBeTrue();
});
test("vector seals survive restart, bind hot-cache counts and reject physical edits and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-vector-seal-")),
    store = new VectorSealStore(root),
    name = "a".repeat(64),
    signal = new AbortController().signal;
  try {
    const ref = await store.put(name, "recipe", 4, [["b".repeat(64), "c".repeat(64)]], signal);
    expect((await store.read(ref, "recipe", 4, signal)).rows.size).toBe(1);
    expect((await new VectorSealStore(root).read(ref, "recipe", 4, signal)).rows.size).toBe(1);
    await expect(
      store.read({ ...ref, integrity: { ...ref.integrity!, count: 2 } }, "recipe", 4, signal),
    ).rejects.toMatchObject({ reason: "corrupt" });
    const path = join(root, name + ".json"),
      original = await readFile(path),
      value = JSON.parse(original.toString());
    value.rows[0][1] = "d".repeat(64);
    await writeFile(path, JSON.stringify(value));
    await expect(store.read(ref, "recipe", 4, signal)).rejects.toMatchObject({ reason: "corrupt" });
    await rm(path);
    await symlink(join(root, "outside.json"), path);
    await writeFile(join(root, "outside.json"), original);
    await expect(store.read(ref, "recipe", 4, signal)).rejects.toMatchObject({ reason: "corrupt" });
    expect(await readFile(join(root, "outside.json"))).toEqual(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
