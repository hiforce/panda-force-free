import { expect, test } from "bun:test";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import {
  projectDraftFixture,
  autosaveCommand,
  checkpointCommand,
  draftAuthor,
} from "../support/project-draft-fixture.js";

test.concurrent(
  "a checkpointed working generation never resurfaces after a later source revision and accepts a fresh edit",
  async () => {
    const f = await projectDraftFixture();
    try {
      const first = autosaveCommand(),
        receipt = await f.project.drafts.put(first);
      await f.project.checkpoints.save(checkpointCommand());
      const later = projectDocumentFixture(3, "doc-1", "A later saved source");
      await f.project.documents.put(later, 2, "later-source-change", draftAuthor);
      const reopened = new ProjectContentProject(f.owned),
        state = await reopened.drafts.get("doc-1");
      expect(state).toMatchObject({
        dirty: false,
        stale: false,
        content: null,
        version: 1,
        baseRevisionId: later.revision.id,
      });
      const next = autosaveCommand("fresh-generation", 1, later.revision.id);
      next.content.content = "A fresh working change";
      expect((await reopened.drafts.put(next)).version).toBe(2);
      expect(await reopened.drafts.put(first)).toEqual(receipt);
      expect((await reopened.drafts.get("doc-1")).content).toEqual(next.content);
      expect((await reopened.documents.get("doc-1")).revision.id).toBe(later.revision.id);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "explicit checkpoints create saved history once while repeated and unchanged saves preserve the head",
  async () => {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put(autosaveCommand());
      const initial = await f.snapshots.head(),
        command = checkpointCommand(),
        first = await f.project.checkpoints.save(command);
      expect(first.changed).toBe(true);
      expect(first.detail.document.revision).toBe(2);
      expect(first.detail.revision.content).toBe("Unsaved source");
      expect(first.commit).not.toBe(initial);
      const reopened = new ProjectContentProject(f.owned),
        state = await reopened.drafts.get("doc-1");
      expect(state).toMatchObject({
        version: 1,
        dirty: false,
        stale: false,
        content: null,
        baseRevisionId: first.detail.revision.id,
      });
      const unchanged = await reopened.checkpoints.save(checkpointCommand("unchanged", 1, first.detail.revision.id));
      expect(unchanged.changed).toBe(false);
      expect(unchanged.commit).toBe(first.commit);
      const next = autosaveCommand("second-draft", 1, first.detail.revision.id);
      next.content.title = "Second checkpoint";
      next.content.content = "New saved original";
      await reopened.drafts.put(next);
      const second = await reopened.checkpoints.save(
          checkpointCommand("second-checkpoint", 2, first.detail.revision.id),
        ),
        head = await f.snapshots.head();
      expect(second.detail.document.revision).toBe(3);
      expect(await reopened.checkpoints.save(command)).toEqual(first);
      expect((await reopened.documents.get("doc-1")).revision.id).toBe(second.detail.revision.id);
      expect(await f.snapshots.head()).toBe(head);
      expect((await reopened.documents.revisions("doc-1")).map((row) => row.id)).toEqual([
        second.detail.revision.id,
        first.detail.revision.id,
        f.detail.revision.id,
      ]);
      await expect(
        reopened.checkpoints.save({ ...command, author: { ...draftAuthor, name: "Another author" } }),
      ).rejects.toThrow("conflict");
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "late autosaves cannot resurrect old content, and a newer working generation blocks a stale checkpoint",
  async () => {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put(autosaveCommand());
      const late = autosaveCommand("late", 1);
      late.content.content = "Late old-base text";
      const results = await Promise.allSettled([
        f.project.checkpoints.save(checkpointCommand()),
        f.project.drafts.put(late),
      ]);
      expect(results.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
      const current = await f.project.documents.get("doc-1");
      expect((await f.project.drafts.get("doc-1")).dirty).toBe(false);
      await f.project.drafts.put(autosaveCommand("next", 1, current.revision.id));
      const newer = autosaveCommand("newer", 2, current.revision.id);
      newer.content.content = "Latest working text";
      const competing = await Promise.allSettled([
        f.project.drafts.put(newer),
        f.project.checkpoints.save(checkpointCommand("stale-draft-version", 2, current.revision.id)),
      ]);
      expect(competing.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
      expect((await f.project.drafts.get("doc-1")).content?.content).toBe("Latest working text");
      expect((await f.project.documents.get("doc-1")).revision.id).toBe(current.revision.id);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "independent source changes retain a stale working copy until an explicit discard",
  async () => {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put(autosaveCommand());
      const second = projectDocumentFixture(2);
      second.revision.content = "Exact source\r\n";
      await f.project.documents.put(second, 1, "independent-version", draftAuthor);
      const stale = await f.project.drafts.get("doc-1");
      expect(stale).toMatchObject({
        version: 1,
        dirty: true,
        stale: true,
        baseRevisionId: f.detail.revision.id,
        savedRevisionId: second.revision.id,
      });
      await expect(
        f.project.checkpoints.save(checkpointCommand("stale-checkpoint", 1, second.revision.id)),
      ).rejects.toThrow("conflict");
      await expect(f.project.drafts.put(autosaveCommand("implicit-rebase", 1, second.revision.id))).rejects.toThrow(
        "conflict",
      );
      expect((await f.project.drafts.get("doc-1")).content?.content).toBe("Unsaved source");
      await f.project.drafts.discard({
        documentId: "doc-1",
        operationId: "discard-stale",
        actor: "user:editor",
        expectedVersion: 1,
        baseRevisionId: second.revision.id,
      });
      expect((await f.project.drafts.get("doc-1")).dirty).toBe(false);
      expect((await f.project.drafts.put(autosaveCommand("fresh", 2, second.revision.id))).version).toBe(3);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "restoring a historical version creates a new checkpoint and preserves later saved and unsaved work",
  async () => {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put(autosaveCommand());
      const saved = await f.project.checkpoints.save(checkpointCommand());
      const working = autosaveCommand("later-working", 1, saved.detail.revision.id);
      working.content.content = "A working copy to preserve";
      await f.project.drafts.put(working);
      const restored = await f.project.checkpoints.restore({
        ...checkpointCommand("restore", 2, saved.detail.revision.id),
        revisionId: f.detail.revision.id,
      });
      expect(restored.detail.document.revision).toBe(3);
      expect(restored.detail.revision.content).toBe(f.detail.revision.content);
      expect(restored.detail.revision.id).not.toBe(f.detail.revision.id);
      expect((await f.project.documents.revision("doc-1", saved.detail.revision.id)).content).toBe("Unsaved source");
      expect(await f.project.documents.revisions("doc-1")).toHaveLength(3);
      expect(await f.project.drafts.get("doc-1")).toMatchObject({
        stale: true,
        dirty: true,
        version: 2,
        content: working.content,
      });
      expect(
        await f.project.checkpoints.restore({
          ...checkpointCommand("restore", 2, saved.detail.revision.id),
          revisionId: f.detail.revision.id,
        }),
      ).toEqual(restored);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "checkpoint guards reject duplicate translation locales, foreign image ownership and writes to trash",
  async () => {
    const f = await projectDraftFixture();
    try {
      const other = projectDocumentFixture(1, "other");
      other.document.locale = other.revision.locale = "fr";
      await f.project.documents.put(other, null, "other-document", draftAuthor);
      await f.project.languages.link("doc-1", "other", "language-group", draftAuthor);
      const first = autosaveCommand();
      first.content.locale = "fr";
      await f.project.drafts.put(first);
      const head = await f.snapshots.head();
      await expect(f.project.checkpoints.save(checkpointCommand())).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(head);
      const asset = {
        id: "11111111-1111-4111-8111-111111111111",
        documentId: "other",
        name: "image.png",
        mime: "image/png" as const,
        digest: "a".repeat(64),
        size: 100,
        width: 1,
        height: 1,
        alt: "",
        createdAt: 100,
      };
      await f.project.assets.put(asset, "foreign-image", draftAuthor);
      const foreign = autosaveCommand("foreign-reference", 1);
      foreign.content.resources = [
        { assetId: asset.id, digest: asset.digest, source: "image.png", sourcePath: "images/image.png" },
      ];
      await f.project.drafts.put(foreign);
      await expect(f.project.checkpoints.save(checkpointCommand("foreign-image-checkpoint", 2))).rejects.toThrow(
        "invalidFile",
      );
      const own = { ...asset, id: "22222222-2222-4222-8222-222222222222", documentId: "doc-1" };
      await f.project.assets.put(own, "own-image", draftAuthor);
      const valid = autosaveCommand("own-reference", 2);
      valid.content.resources = [
        { assetId: own.id, digest: own.digest, source: "image.png", sourcePath: "images/image.png" },
      ];
      await f.project.drafts.put(valid);
      const saved = await f.project.checkpoints.save(checkpointCommand("own-image-checkpoint", 3));
      expect(saved.detail.revision.resources).toEqual(valid.content.resources);
      await f.project.navigation.put(
        {
          spaceId: "space-1",
          version: 0,
          nodes: [{ documentId: "other", parentId: null, position: 0 }],
          trash: [{ documentId: "doc-1", deletedAt: 100, parentId: null, position: null, operationId: null }],
          origins: [],
          lastOperation: null,
        },
        null,
        "trash",
        draftAuthor,
      );
      await expect(f.project.drafts.put(autosaveCommand("after-trash", 3, saved.detail.revision.id))).rejects.toThrow(
        "notFound",
      );
      await expect(
        f.project.checkpoints.save(checkpointCommand("after-trash-checkpoint", 3, saved.detail.revision.id)),
      ).rejects.toThrow("notFound");
    } finally {
      await f.close();
    }
  },
  30000,
);
