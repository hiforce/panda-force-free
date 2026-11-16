import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { FileCapturedSources } from "../../src/server/packages/captures/content.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";

test("durable source files survive a fresh process without provider access and concurrent writes retain one complete source", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-source-capture-"));
  try {
    const raw = new TextEncoder().encode("Persistent original 文档"),
      archive = zipSync({ "theme/layout/index.ejs": raw, "theme/logo.png": new Uint8Array([0, 255]) }),
      reader = await openZipSource(archive, "theme.zip"),
      snapshot = await captureSourceSnapshot(reader, ["theme/layout/index.ejs"], archive),
      files = new FileCapturedSources(root);
    await Promise.all([files.put(snapshot), files.put(snapshot)]);
    expect(await readdir(root)).toEqual([snapshot.digest + ".source"]);
    const stored = await readFile(join(root, snapshot.digest + ".source"));
    expect(stored.includes(Buffer.from(raw))).toBe(true);
    expect(stored.includes(Buffer.from(archive))).toBe(true);
    const child = Bun.spawn(["bun", "tests/support/read-source-capture.ts", root, snapshot.digest], {
        stdout: "pipe",
        stderr: "pipe",
      }),
      output = await new Response(child.stdout).text(),
      errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    expect(JSON.parse(output)).toEqual({
      digest: snapshot.digest,
      treeDigest: snapshot.tree.digest,
      paths: ["theme/layout/index.ejs"],
      inventory: ["theme/layout/index.ejs", "theme/logo.png"],
      original: Buffer.from(archive).toString("base64"),
      content: "Persistent original 文档",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable source reads reject corrupted payloads, path keys and final symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-source-tamper-"));
  try {
    const archive = zipSync({ "content.md": new TextEncoder().encode("Original") }),
      reader = await openZipSource(archive, "template.zip"),
      snapshot = await captureSourceSnapshot(reader, undefined, archive),
      files = new FileCapturedSources(root),
      target = join(root, snapshot.digest + ".source");
    await files.put(snapshot);
    const bytes = await readFile(target);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(target, bytes);
    await expect(new FileCapturedSources(root).read(snapshot.digest)).rejects.toThrow("sourceChanged");
    await expect(files.put(snapshot)).rejects.toThrow("sourceChanged");
    await expect(files.read("../outside")).rejects.toThrow("invalidDigest");
    await unlink(target);
    const outside = join(root, "unrelated");
    await writeFile(outside, "Not a source");
    await symlink(outside, target);
    await expect(files.read(snapshot.digest)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("Not a source");
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
