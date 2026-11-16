import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnedProjectDirectory,
  openOwnedProjectDirectory,
} from "../../src/server/project-content/owned-directory.js";
import { projectGit } from "../../src/server/project-content/git/process.js";

test("project ownership initializes a dedicated local repository and reopens it without changing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-content-owner-"));
  try {
    const first = await createOwnedProjectDirectory(root, "project-1"),
      second = await createOwnedProjectDirectory(root, "project-1");
    expect(second.ownerId).toBe(first.ownerId);
    expect(second.coordination).toBe(first.coordination);
    expect((await openOwnedProjectDirectory(root + "/", "project-1")).ownerId).toBe(first.ownerId);
    await expect(openOwnedProjectDirectory("relative-content", "project-1")).rejects.toMatchObject({ code: "unowned" });
    await first.verify();
    expect((await projectGit(first.directory, ["remote"])).toString()).toBe("");
    expect((await projectGit(first.directory, ["rev-list", "--count", "HEAD"])).toString().trim()).toBe("1");
    const another = await createOwnedProjectDirectory(root, "project-2");
    expect(another.ownerId).not.toBe(first.ownerId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing repositories, plain directories and interrupted initializations are refused without rewriting their files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-content-foreign-"));
  try {
    await mkdir(join(root, "projects"));
    for (const id of ["source", "empty", "interrupted"]) await mkdir(join(root, "projects", id));
    const source = join(root, "projects", "source");
    await projectGit(source, ["init", "--template=", "--initial-branch=main"]);
    await writeFile(join(source, "important.md"), "user-owned source");
    await writeFile(join(root, "projects", "interrupted", ".panda-initialize.json"), '{"schema":1}');
    const config = await readFile(join(source, ".git", "config"));
    for (const id of ["source", "empty", "interrupted"])
      await expect(createOwnedProjectDirectory(root, id)).rejects.toMatchObject({ code: "unowned" });
    expect(await readFile(join(source, ".git", "config"))).toEqual(config);
    expect(await readFile(join(source, "important.md"), "utf8")).toBe("user-owned source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ownership rejects project symlinks, repository reconfiguration and foreign object storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-content-boundary-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "owned");
    await symlink(owned.directory, join(root, "projects", "linked"));
    await expect(openOwnedProjectDirectory(root, "linked")).rejects.toMatchObject({ code: "unowned" });
    await projectGit(owned.directory, ["config", "core.worktree", "/foreign/source"]);
    await expect(owned.verify()).rejects.toMatchObject({ code: "unowned" });
    const second = await createOwnedProjectDirectory(root, "second");
    await writeFile(join(second.directory, ".git", "objects", "info", "alternates"), "/foreign/objects\n");
    await expect(second.verify()).rejects.toMatchObject({ code: "unowned" });
    await expect(createOwnedProjectDirectory(root, "../escape")).rejects.toMatchObject({ code: "invalidFile" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
