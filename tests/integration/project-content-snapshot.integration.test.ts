import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFilePath } from "../../src/server/project-content/paths.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";

import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";

const author = { name: "Project author", email: "author@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-content-tree-"));
  const owned = await createOwnedProjectDirectory(root, "project"),
    store = new ProjectGitSnapshots(owned);
  return {
    directory: owned.directory,
    initial: await store.head(),
    store,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("Git snapshots retain exact immutable content while excluding unrelated files, the index and assets", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "private-attachment.png"), "attachment bytes stay outside history");
    await projectGit(f.directory, ["add", "--", "private-attachment.png"]);
    const prepared = await f.store.prepare(
      f.initial,
      [
        { path: "project.json", content: '{"schema":1}\n' },
        { path: "documents/doc-1.panda.json", content: "exact original\r\n" },
      ],
      author,
      "Save project document",
    );
    expect(await f.store.head()).toBe(f.initial);
    expect(prepared.changed).toBe(true);
    expect((await f.store.entries(prepared.commit)).map((row) => row.path)).toEqual([
      "documents/doc-1.panda.json",
      "project.json",
    ]);
    const entry = prepared.entries.find((row) => row.path.startsWith("documents/"))!;
    expect((await f.store.content(entry.blob)).toString()).toBe("exact original\r\n");
    await f.store.publish(f.initial, prepared.commit);
    const second = await f.store.prepare(
      prepared.commit,
      [{ path: entry.path, content: "second version\n" }],
      author,
      "Update project document",
    );
    await f.store.publish(prepared.commit, second.commit);
    expect((await f.store.content(entry.blob)).toString()).toBe("exact original\r\n");
    expect(await f.store.head()).toBe(second.commit);
    expect((await projectGit(f.directory, ["remote"])).toString()).toBe("");
  } finally {
    await f.close();
  }
});

test("unchanged content adds no commit and stale writers cannot replace an advanced reference", async () => {
  const f = await fixture();
  try {
    const one = await f.store.prepare(f.initial, [{ path: "tree.json", content: "one" }], author, "First tree");
    const competing = await f.store.prepare(f.initial, [{ path: "tree.json", content: "other" }], author, "Other tree");
    await f.store.publish(f.initial, one.commit);
    await expect(f.store.publish(f.initial, competing.commit)).rejects.toMatchObject({ code: "conflict" });
    const same = await f.store.prepare(one.commit, [{ path: "tree.json", content: "one" }], author, "Unchanged tree");
    expect(same.changed).toBe(false);
    expect(same.commit).toBe(one.commit);
    const removed = await f.store.prepare(one.commit, [{ path: "tree.json", content: null }], author, "Remove tree");
    expect(await f.store.entries(removed.commit)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("project history rejects attachment paths, traversal, duplicate mutations and symlink tree entries", async () => {
  const f = await fixture();
  try {
    for (const path of [
      ".git/config",
      "assets/a.png",
      "documents/../../config",
      "documents/doc-1.png",
      "/project.json",
    ])
      expect(() => projectFilePath(path)).toThrow();
    await expect(
      f.store.prepare(
        f.initial,
        [
          { path: "tree.json", content: "a" },
          { path: "tree.json", content: "b" },
        ],
        author,
        "Invalid mutation",
      ),
    ).rejects.toThrow();
    await symlink("../private", join(f.directory, "tree.json"));
    await projectGit(f.directory, ["add", "--", "tree.json"]);
    const tree = (await projectGit(f.directory, ["write-tree"])).toString().trim();
    const foreign = (
      await projectGit(f.directory, ["commit-tree", tree], { input: "Foreign symlink\n", identity: author })
    )
      .toString()
      .trim();
    await expect(f.store.entries(foreign)).rejects.toMatchObject({ code: "invalidFile" });
  } finally {
    await f.close();
  }
});
