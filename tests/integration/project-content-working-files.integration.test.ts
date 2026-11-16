import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, symlink, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectWorkingFiles, readContentFile } from "../../src/server/project-content/working-files.js";

test("owned working files retain exact bytes and reject stale updates and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-working-files-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project"),
      files = new ProjectWorkingFiles(owned);
    const path = "documents/doc-1.panda.json",
      first = Buffer.from("original\r\n"),
      second = Buffer.from("second\n");
    expect(await files.read(path)).toBeNull();
    await files.replace(path, null, first, () => {});
    expect(await files.read(path)).toEqual(first);
    await files.replace(path, first, second, () => {});
    await expect(files.replace(path, first, Buffer.from("stale"), () => {})).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(join(owned.directory, path))).toEqual(second);
    await expect(readContentFile(join(owned.directory, path), 2)).rejects.toMatchObject({ code: "invalidFile" });
    await files.replace(path, second, null, () => {});
    expect(await files.read(path)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lost coordination before replacement leaves the original file intact and removes only its own temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-file-fence-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project"),
      files = new ProjectWorkingFiles(owned);
    const path = "tree.json",
      first = Buffer.from("original"),
      lost = () => {
        throw Error("Lost ownership");
      };
    await files.replace(path, null, first, () => {});
    await expect(files.replace(path, first, Buffer.from("replacement"), lost)).rejects.toThrow("Lost ownership");
    expect(await files.read(path)).toEqual(first);
    expect((await readdir(owned.directory)).filter((name) => name.startsWith(".panda-write-"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content replacement refuses symlinked containers and preserves unrelated project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-file-containment-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project"),
      files = new ProjectWorkingFiles(owned),
      outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "doc-1.panda.json"), "outside original");
    await symlink(outside, join(owned.directory, "documents"));
    await expect(
      files.replace("documents/doc-1.panda.json", null, Buffer.from("replacement"), () => {}),
    ).rejects.toThrow();
    expect(await readFile(join(outside, "doc-1.panda.json"), "utf8")).toBe("outside original");
    await writeFile(join(owned.directory, "attachment.png"), "unrelated bytes");
    await expect(files.replace("attachment.png", null, Buffer.from("replacement"), () => {})).rejects.toThrow();
    expect(await readFile(join(owned.directory, "attachment.png"), "utf8")).toBe("unrelated bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
