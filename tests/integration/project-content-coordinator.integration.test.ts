import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectContentCoordinator } from "../../src/server/project-content/coordinator.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { withProjectGitLease } from "../../src/server/project-content/git/lease.js";
import { ProjectContentJournal, type ContentMutationJournal } from "../../src/server/project-content/journal.js";
import { ProjectWorkingFiles } from "../../src/server/project-content/working-files.js";
import { projectGit } from "../../src/server/project-content/git/process.js";

const author = { name: "Document author", email: "author@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-file-transaction-")),
    owned = await createOwnedProjectDirectory(root, "project");
  const snapshots = new ProjectGitSnapshots(owned);
  return {
    root,
    owned,
    snapshots,
    coordinator: new ProjectContentCoordinator(owned),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("content operations persist real files, preserve immutable history and replay stable receipts without a second commit", async () => {
  const f = await fixture();
  try {
    const base = await f.snapshots.head(),
      input = {
        operationId: "save-1",
        base,
        author,
        message: "Save project document",
        changes: [
          { path: "documents/doc-1.panda.json", content: "sensitive original\r\n" },
          { path: "tree.json", content: "first tree" },
        ],
      };
    const saved = await f.coordinator.mutate(input);
    expect(saved.commit).not.toBe(base);
    expect(await readFile(join(f.owned.directory, "documents/doc-1.panda.json"), "utf8")).toBe(
      "sensitive original\r\n",
    );
    const reopened = new ProjectContentCoordinator(f.owned),
      read = await reopened.read(["tree.json", "documents/doc-1.panda.json"]);
    expect(read.files.get("documents/doc-1.panda.json")?.toString()).toBe("sensitive original\r\n");
    expect(await reopened.mutate(input)).toEqual(saved);
    expect((await projectGit(f.owned.directory, ["rev-list", "--count", "HEAD"])).toString().trim()).toBe("2");
    const receipt = await readFile(join(f.owned.directory, ".git", "panda", "receipts", "save-1.json"), "utf8");
    expect(receipt.includes("sensitive original")).toBe(false);
    await expect(reopened.mutate({ ...input, message: "Different operation" })).rejects.toMatchObject({
      code: "conflict",
    });
    await writeFile(join(f.owned.directory, "tree.json"), "external manual change");
    await expect(reopened.read(["tree.json"])).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(join(f.owned.directory, "tree.json"), "utf8")).toBe("external manual change");
  } finally {
    await f.close();
  }
});

test("same-project requests serialize and stale baselines fail while unchanged saves add no history", async () => {
  const f = await fixture();
  try {
    const base = await f.snapshots.head(),
      first = {
        operationId: "one",
        base,
        author,
        message: "Save tree",
        changes: [{ path: "tree.json", content: "one" }],
      };
    const outcomes = await Promise.allSettled([
      f.coordinator.mutate(first),
      f.coordinator.mutate({ ...first, operationId: "two", changes: [{ path: "tree.json", content: "two" }] }),
    ]);
    expect(outcomes.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
    const head = await f.snapshots.head();
    const noop = await f.coordinator.mutate({ ...first, operationId: "no-change", base: head });
    expect(noop.commit).toBe(head);
    expect(noop.changes).toEqual([]);
    expect((await f.coordinator.read(["tree.json"])).files.get("tree.json")?.toString()).toBe("one");
    expect((await projectGit(f.owned.directory, ["rev-list", "--count", "HEAD"])).toString().trim()).toBe("2");
  } finally {
    await f.close();
  }
});

for (const phase of ["prepared", "partial-files", "all-files", "published", "receipt"] as const) {
  test("durable recovery completes exactly one operation from " + phase, async () => {
    const f = await fixture();
    try {
      const base = await f.snapshots.head(),
        prepared = await f.snapshots.prepare(
          base,
          [
            { path: "tree.json", content: "recovered tree" },
            { path: "documents/doc-1.panda.json", content: "recovered original\r\n" },
          ],
          author,
          "Prepare recovery fixture",
        );
      const journal: ContentMutationJournal = {
        schema: 1,
        operationId: "recover",
        requestHash: "a".repeat(64),
        base,
        commit: prepared.commit,
        changes: prepared.entries.map((row) => ({ path: row.path, before: null, after: row.blob })),
      };
      const store = new ProjectContentJournal(f.owned),
        files = new ProjectWorkingFiles(f.owned);
      await withProjectGitLease(f.owned.directory, f.owned.coordination, async (lease) => {
        await store.writePending(journal, lease.assertHeld);
        if (phase !== "prepared") {
          const first = prepared.entries[0]!;
          await files.replace(first.path, null, await f.snapshots.content(first.blob), lease.assertHeld);
        }
        if (["all-files", "published", "receipt"].includes(phase)) {
          const second = prepared.entries[1]!;
          await files.replace(second.path, null, await f.snapshots.content(second.blob), lease.assertHeld);
        }
        if (["published", "receipt"].includes(phase)) await f.snapshots.publish(base, prepared.commit);
        if (phase === "receipt") await store.writeReceipt(journal, lease.assertHeld);
      });
      const reopened = new ProjectContentCoordinator(f.owned),
        current = await reopened.read(["tree.json", "documents/doc-1.panda.json"]);
      expect(current.commit).toBe(prepared.commit);
      expect(current.files.get("tree.json")?.toString()).toBe("recovered tree");
      expect(current.files.get("documents/doc-1.panda.json")?.toString()).toBe("recovered original\r\n");
      expect(await store.pending()).toBeNull();
      expect(await store.receipt("recover")).toEqual(journal);
      expect((await projectGit(f.owned.directory, ["rev-list", "--count", "HEAD"])).toString().trim()).toBe("2");
      expect((await reopened.read(["tree.json"])).commit).toBe(prepared.commit);
    } finally {
      await f.close();
    }
  });
}

test("recovery refuses unknown manual bytes before changing any other target", async () => {
  const f = await fixture();
  try {
    const base = await f.snapshots.head(),
      prepared = await f.snapshots.prepare(
        base,
        [
          { path: "tree.json", content: "planned tree" },
          { path: "project.json", content: "planned project" },
        ],
        author,
        "Prepare conflicting fixture",
      );
    const journal: ContentMutationJournal = {
      schema: 1,
      operationId: "conflict",
      requestHash: "b".repeat(64),
      base,
      commit: prepared.commit,
      changes: prepared.entries.map((row) => ({ path: row.path, before: null, after: row.blob })),
    };
    await withProjectGitLease(f.owned.directory, f.owned.coordination, (lease) =>
      new ProjectContentJournal(f.owned).writePending(journal, lease.assertHeld),
    );
    await writeFile(join(f.owned.directory, "tree.json"), "unknown manual content");
    await expect(new ProjectContentCoordinator(f.owned).read(["tree.json"])).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await Bun.file(join(f.owned.directory, "project.json")).exists()).toBe(false);
    expect(await f.snapshots.head()).toBe(base);
    expect(await readFile(join(f.owned.directory, "tree.json"), "utf8")).toBe("unknown manual content");
    expect(await new ProjectContentJournal(f.owned).pending()).toEqual(journal);
  } finally {
    await f.close();
  }
});

test("recovery never restores externally removed files after the content reference was already published", async () => {
  const f = await fixture();
  try {
    const base = await f.snapshots.head(),
      prepared = await f.snapshots.prepare(
        base,
        [{ path: "tree.json", content: "committed tree" }],
        author,
        "Prepare published fixture",
      );
    const journal: ContentMutationJournal = {
      schema: 1,
      operationId: "published-conflict",
      requestHash: "c".repeat(64),
      base,
      commit: prepared.commit,
      changes: prepared.entries.map((row) => ({ path: row.path, before: null, after: row.blob })),
    };
    await withProjectGitLease(f.owned.directory, f.owned.coordination, async (lease) => {
      await new ProjectContentJournal(f.owned).writePending(journal, lease.assertHeld);
      await new ProjectWorkingFiles(f.owned).replace(
        "tree.json",
        null,
        Buffer.from("committed tree"),
        lease.assertHeld,
      );
      await f.snapshots.publish(base, prepared.commit);
    });
    await unlink(join(f.owned.directory, "tree.json"));
    await expect(new ProjectContentCoordinator(f.owned).read(["tree.json"])).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await Bun.file(join(f.owned.directory, "tree.json")).exists()).toBe(false);
    expect(await f.snapshots.head()).toBe(prepared.commit);
  } finally {
    await f.close();
  }
});
