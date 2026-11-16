import { expect, test } from "bun:test";
import { readFile, unlink, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { projectDraftFixture, autosaveCommand } from "../support/project-draft-fixture.js";

const draftPath = (root: string) => join(root, ".git", "panda", "drafts", "doc-1.json");
const receiptPath = (root: string, id: string) => join(root, ".git", "panda", "draft-receipts", id + ".json");

test.concurrent(
  "autosave survives reopen without changing saved originals or adding draft bytes to Git",
  async () => {
    const f = await projectDraftFixture();
    try {
      const head = await f.snapshots.head(),
        first = autosaveCommand();
      first.content.content = "UNSAVED-DRAFT-NOT-A-GIT-OBJECT\r\n";
      expect((await f.project.drafts.get("doc-1")).version).toBe(0);
      const receipt = await f.project.drafts.put(first);
      expect(receipt.version).toBe(1);
      expect(await f.snapshots.head()).toBe(head);
      const reopened = new ProjectContentProject(f.owned),
        state = await reopened.drafts.get("doc-1");
      expect(state).toMatchObject({
        version: 1,
        dirty: true,
        stale: false,
        baseRevisionId: first.baseRevisionId,
        content: first.content,
      });
      expect(await reopened.documents.get("doc-1")).toEqual(f.detail);
      expect(await reopened.documents.revisions("doc-1")).toHaveLength(1);
      const second = {
        ...first,
        operationId: "autosave-2",
        expectedVersion: 1,
        content: { ...first.content, content: "A newer working draft" },
      };
      expect((await reopened.drafts.put(second)).version).toBe(2);
      expect(await reopened.drafts.put(first)).toEqual(receipt);
      expect((await reopened.drafts.get("doc-1")).content).toEqual(second.content);
      expect(await f.snapshots.head()).toBe(head);
      const objects = (
        await projectGit(f.owned.directory, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objecttype) %(objectname)",
        ])
      )
        .toString()
        .trim()
        .split("\n");
      for (const row of objects.filter((row) => row.startsWith("blob ")))
        expect((await f.snapshots.content(row.slice(5))).toString()).not.toContain("UNSAVED-DRAFT-NOT-A-GIT-OBJECT");
      expect(await readFile(receiptPath(f.owned.directory, first.operationId), "utf8")).not.toContain(
        first.content.content,
      );
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "a durable draft repairs a missing receipt before any later writer replaces its body",
  async () => {
    const f = await projectDraftFixture();
    try {
      const first = autosaveCommand(),
        original = await f.project.drafts.put(first);
      await unlink(receiptPath(f.owned.directory, first.operationId));
      const reopened = new ProjectContentProject(f.owned),
        second = autosaveCommand("second", 1);
      second.content.content = "Second pending body";
      await reopened.drafts.put(second);
      expect(JSON.parse(await readFile(receiptPath(f.owned.directory, first.operationId), "utf8"))).toEqual(original);
      expect(await reopened.drafts.put(first)).toEqual(original);
      expect((await reopened.drafts.get("doc-1")).content?.content).toBe("Second pending body");
      await expect(reopened.drafts.put({ ...first, actor: "other-user" })).rejects.toThrow("conflict");
      await expect(
        reopened.drafts.put({ ...first, content: { ...first.content, title: "Changed replay" } }),
      ).rejects.toThrow("conflict");
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "draft generations reject competing editors and discard receipts never erase later autosaves",
  async () => {
    const f = await projectDraftFixture();
    try {
      const first = autosaveCommand(),
        rival = autosaveCommand("rival");
      rival.content.content = "Rival body";
      const outcome = await Promise.allSettled([f.project.drafts.put(first), f.project.drafts.put(rival)]);
      expect(outcome.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
      const discard = {
          documentId: "doc-1",
          operationId: "discard",
          expectedVersion: 1,
          baseRevisionId: first.baseRevisionId,
          actor: first.actor,
        },
        discarded = await f.project.drafts.discard(discard);
      expect(discarded.version).toBe(2);
      expect((await f.project.drafts.get("doc-1")).content).toBeNull();
      await expect(f.project.drafts.put({ ...first, operationId: "late", expectedVersion: 1 })).rejects.toThrow(
        "conflict",
      );
      const next = autosaveCommand("next", 2),
        receipt = await f.project.drafts.put(next);
      expect(receipt.version).toBe(3);
      expect(await f.project.drafts.discard(discard)).toEqual(discarded);
      expect((await f.project.drafts.get("doc-1")).content).toEqual(next.content);
      expect((await f.project.drafts.put({ ...next, operationId: "unchanged", expectedVersion: 3 })).version).toBe(3);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "draft input is captured before I/O and corrupt or redirected working files are preserved and rejected",
  async () => {
    const f = await projectDraftFixture();
    try {
      const first = autosaveCommand(),
        body = emptyRichBody();
      body.document.content![0]!.content = [{ type: "text", text: "Original rich input" }];
      first.content.body = body;
      const original = structuredClone(first),
        pending = f.project.drafts.put(first);
      body.document.content![0]!.content![0]!.text = "Changed rich input after call";
      first.actor = "Changed actor";
      first.content.content = "Changed after call";
      await pending;
      expect((await f.project.drafts.get("doc-1")).content).toEqual(original.content);
      const head = await f.snapshots.head(),
        path = draftPath(f.owned.directory);
      await writeFile(path, "manually changed draft bytes");
      await expect(f.project.drafts.get("doc-1")).rejects.toThrow("invalidFile");
      await expect(f.project.drafts.put(autosaveCommand("after-manual-change", 1))).rejects.toThrow("invalidFile");
      expect(await readFile(path, "utf8")).toBe("manually changed draft bytes");
      await unlink(path);
      const destination = join(f.owned.directory, "unrelated.txt");
      await writeFile(destination, "Unrelated owner file");
      await symlink(destination, path);
      await expect(f.project.drafts.put(autosaveCommand("redirected", 1))).rejects.toThrow();
      expect(await readFile(destination, "utf8")).toBe("Unrelated owner file");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);
