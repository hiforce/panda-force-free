import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { projectPlacementFile, encodePlacementRecords } from "../../src/server/project-content/placement-file.js";
import { projectRecordShard } from "../../src/server/project-content/record-shards.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";
import {
  placementFixture,
  projectPlacementFixture,
  placementAuthor as author,
} from "../support/project-placement-fixture.js";

const put = (
  f: Awaited<ReturnType<typeof placementFixture>>,
  value: ReturnType<typeof projectPlacementFixture>,
  expected: number | null,
  id: string,
) => f.project.placements.put(value, expected, id, author);

test.concurrent(
  "placement versions, pinned revisions and destination versions survive reopen and replay without rollback",
  async () => {
    const f = await placementFixture();
    try {
      const first = projectPlacementFixture(),
        second = projectPlacementFixture(2);
      second.placement.path = "articles/revised.md";
      await f.project.documents.put(projectDocumentFixture(2), 1, "source-second", author);
      expect(await f.project.placements.get(first.placement.id)).toBeNull();
      expect(await put(f, first, null, "create")).toEqual(first);
      expect(await put(f, second, 1, "update")).toEqual(second);
      const removed = projectPlacementFixture(3);
      removed.placement = { ...second.placement, version: 3, updatedAt: 104, deletedAt: 104 };
      removed.audit = { operation: "remove", actor: "Other editor", createdAt: 105 };
      expect(await put(f, removed, 2, "remove")).toEqual(removed);
      const reopened = new ProjectContentProject(f.owned),
        head = await f.snapshots.head();
      expect(await reopened.placements.get(first.placement.id)).toEqual(removed);
      expect(await reopened.placements.put(first, null, "create", author)).toEqual(first);
      expect(await reopened.placements.get(first.placement.id)).toEqual(removed);
      expect(await reopened.placements.list("spaceId", "target-1")).toEqual([]);
      expect(await reopened.placements.list("documentId", "doc-1")).toEqual([]);
      expect(await f.snapshots.head()).toBe(head);
      expect((await reopened.spaces.get("target-1")).space.version).toBe(4);
      expect((await reopened.spaces.get("target-1")).sourceProfile).toEqual(f.target.sourceProfile);
      expect((await reopened.spaces.get("space-1")).space.version).toBe(1);
      for (const record of [first, second, removed])
        expect(await reopened.placements.event(first.placement.id, record.placement.version)).toEqual({
          placement: record.placement,
          ...record.audit,
        });
      expect((await reopened.placements.history(first.placement.id)).map((entry) => entry.placement.version)).toEqual([
        3, 2, 1,
      ]);
      expect((await reopened.placements.history(first.placement.id, 1))[0]?.audit.operation).toBe("remove");
      await expect(reopened.placements.put(projectPlacementFixture(4), 3, "revive", author)).rejects.toThrow(
        "conflict",
      );
      await expect(reopened.placements.put(second, 1, "create", author)).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(head);
      expect(await f.project.documents.revision("doc-1", "doc-1-rev-1")).toEqual(projectDocumentFixture().revision);
      expect((await f.snapshots.entries(head)).some((row) => row.path.includes("asset-blobs"))).toBe(false);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "concurrent placement writes serialize path and document-locale uniqueness with compare-and-swap",
  async () => {
    const f = await placementFixture();
    try {
      const first = projectPlacementFixture(),
        competing = projectPlacementFixture(1, "competing");
      competing.placement.path = "other.md";
      const outcomes = await Promise.allSettled([
        put(f, first, null, "create"),
        put(f, competing, null, "duplicate-locale"),
      ]);
      expect(outcomes.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
      const second = projectPlacementFixture(2),
        rival = structuredClone(second);
      second.placement.path = "second.md";
      rival.placement.path = "rival.md";
      const updates = await Promise.allSettled([put(f, second, 1, "second"), put(f, rival, 1, "rival")]);
      expect(updates.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
      expect(await f.project.placements.get(first.placement.id)).toEqual(second);
      expect((await f.project.spaces.get("target-1")).space.version).toBe(3);
      const head = await f.snapshots.head();
      for (const changed of [{ documentId: "doc-2" }, { spaceId: "space-1" }, { createdAt: 11 }])
        await expect(
          put(
            f,
            { ...projectPlacementFixture(3), placement: { ...second.placement, version: 3, ...changed } },
            2,
            "identity-" + Object.keys(changed)[0],
          ),
        ).rejects.toThrow("conflict");
      const remove = {
        ...projectPlacementFixture(3),
        placement: { ...second.placement, version: 3, deletedAt: 1000, path: "changed-on-remove.md" },
        audit: { operation: "remove" as const, actor: "Editor", createdAt: 1000 },
      };
      await expect(put(f, remove, 2, "bad-remove")).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "portable paths collide with originals and other placements, while trash releases destination paths",
  async () => {
    const f = await placementFixture();
    try {
      const occupied = projectDocumentFixture(1, "occupied");
      occupied.document.spaceId = "target-1";
      occupied.document.path = "Café.md";
      await f.project.documents.put(occupied, null, "occupied", author);
      const first = projectPlacementFixture();
      first.placement.path = "CAFE\u0301.md";
      const head = await f.snapshots.head();
      await expect(put(f, first, null, "path-conflict")).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(head);
      await f.project.navigation.put(
        {
          spaceId: "target-1",
          version: 0,
          nodes: [],
          trash: [{ documentId: "occupied", deletedAt: 100, parentId: null, position: null, operationId: null }],
          origins: [],
          lastOperation: null,
        },
        null,
        "trash-occupied",
        author,
      );
      await put(f, first, null, "available");
      const other = projectDocumentFixture(1, "doc-2");
      await f.project.documents.put(other, null, "other-source", author);
      const duplicate = projectPlacementFixture(1, "other-placement");
      duplicate.placement.documentId = "doc-2";
      duplicate.placement.revisionId = other.revision.id;
      duplicate.placement.path = "café.md";
      await expect(put(f, duplicate, null, "placement-path-conflict")).rejects.toThrow("conflict");
      duplicate.placement.path = "free.md";
      await put(f, duplicate, null, "other-available");
      expect((await f.project.placements.list("spaceId", "target-1")).map((row) => row.id)).toEqual([
        "other-placement",
        "placement-1",
      ]);
      expect((await f.project.placements.list("documentId", "doc-2")).map((row) => row.id)).toEqual([
        "other-placement",
      ]);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "placement references validate saved language and ownership, and a trashed source can still be unlinked",
  async () => {
    const f = await placementFixture();
    try {
      const initial = projectPlacementFixture(),
        second = projectDocumentFixture(2);
      second.document.locale = second.revision.locale = "zh-CN";
      await f.project.documents.put(second, 1, "change-language", author);
      await put(f, initial, null, "pinned-old-language");
      const other = projectDocumentFixture(1, "doc-2");
      await f.project.documents.put(other, null, "other-doc", author);
      const next = projectPlacementFixture(2),
        head = await f.snapshots.head();
      for (const revisionId of [null, "missing-revision", other.revision.id])
        await expect(
          put(f, { ...next, placement: { ...next.placement, revisionId } }, 1, "bad-revision-" + revisionId),
        ).rejects.toThrow();
      await expect(
        put(f, { ...next, placement: { ...next.placement, projectId: "foreign-project" } }, 1, "foreign"),
      ).rejects.toThrow("invalidFile");
      await expect(
        put(
          f,
          {
            ...projectPlacementFixture(1, "library-target"),
            placement: { ...projectPlacementFixture(1, "library-target").placement, spaceId: "space-1" },
          },
          null,
          "library-target",
        ),
      ).rejects.toThrow("invalidFile");
      expect(await f.snapshots.head()).toBe(head);
      await f.project.navigation.put(
        {
          spaceId: "space-1",
          version: 0,
          nodes: [{ documentId: "doc-2", parentId: null, position: 0 }],
          trash: [{ documentId: "doc-1", deletedAt: 1000, parentId: null, position: null, operationId: null }],
          origins: [],
          lastOperation: null,
        },
        null,
        "trash-source",
        author,
      );
      await expect(put(f, next, 1, "edit-after-trash")).rejects.toThrow("notFound");
      const removed = {
        ...next,
        placement: { ...initial.placement, version: 2, deletedAt: 1000 },
        audit: { operation: "remove" as const, actor: "Editor", createdAt: 1000 },
      };
      expect(await put(f, removed, 1, "unlink-trashed-source")).toEqual(removed);
      expect((await f.project.placements.history(initial.placement.id)).map((row) => row.audit.operation)).toEqual([
        "remove",
        "create",
      ]);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "placement commands capture mutable input, permit publication-to-publication links, and preserve external edits",
  async () => {
    const f = await placementFixture();
    try {
      await f.project.spaces.put(
        projectSpaceFixture("origin-publication"),
        null,
        "publication",
        "origin-publication",
        author,
      );
      const source = projectDocumentFixture(1, "origin-doc");
      source.document.spaceId = "origin-publication";
      await f.project.documents.put(source, null, "origin-document", author);
      const value = projectPlacementFixture(),
        original = structuredClone(value);
      value.placement.documentId = original.placement.documentId = source.document.id;
      value.placement.revisionId = original.placement.revisionId = source.revision.id;
      const pending = put(f, value, null, "capture");
      value.placement.path = "changed-after-call.md";
      value.placement.metadata.title = "Changed after call";
      value.audit.actor = "Changed actor";
      expect(await pending).toEqual(original);
      const path = join(f.owned.directory, projectPlacementFile(original.placement.id)),
        head = await f.snapshots.head();
      await writeFile(path, "user edited file");
      await expect(f.project.placements.get(original.placement.id)).rejects.toThrow("conflict");
      await expect(put(f, projectPlacementFixture(2), 1, "after-edit")).rejects.toThrow("conflict");
      expect(await readFile(path, "utf8")).toBe("user edited file");
      expect(await f.snapshots.head()).toBe(head);
      await expect(f.project.placements.get("../escape")).rejects.toThrow("invalidFile");
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "destination placement bounds reject creation at capacity while allowing updates of existing links",
  async () => {
    const f = await placementFixture();
    try {
      const first = projectPlacementFixture(),
        shard = projectRecordShard(first.placement.id),
        values = [first];
      for (let index = 0; values.length < 500; index++) {
        const id = "seed-" + index;
        if (projectRecordShard(id) !== shard) continue;
        const value = projectPlacementFixture(1, id);
        value.placement.documentId = "source-" + index;
        value.placement.path = "seed/" + index + ".md";
        values.push(value);
      }
      await f.project.coordinator.mutate({
        operationId: "seed-capacity",
        author,
        message: "Import placement capacity fixture",
        changes: [
          {
            path: projectPlacementFile(first.placement.id),
            content: encodePlacementRecords({ schema: 1, projectId: "project-1", shard, placements: values }),
          },
        ],
      });
      const extra = projectPlacementFixture(1, "extra"),
        head = await f.snapshots.head();
      extra.placement.documentId = "doc-2";
      const other = projectDocumentFixture(1, "doc-2");
      await f.project.documents.put(other, null, "other-source", author);
      extra.placement.revisionId = other.revision.id;
      await expect(put(f, extra, null, "over-capacity")).rejects.toThrow("conflict");
      expect(await f.project.placements.list("spaceId", "target-1")).toHaveLength(500);
      expect(await put(f, projectPlacementFixture(2), 1, "within-capacity")).toEqual(projectPlacementFixture(2));
      expect(await f.snapshots.head()).not.toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "destination version checks execute inside the placement transaction and participate in replay identity",
  async () => {
    const f = await placementFixture();
    try {
      const first = projectPlacementFixture(),
        second = projectPlacementFixture(2);
      await f.project.placements.put(first, null, "first", author, 1);
      const head = await f.snapshots.head();
      await expect(f.project.placements.put(second, 1, "stale-space", author, 1)).rejects.toThrow("conflict");
      await expect(f.project.placements.put(second, 1, "invalid-space-version", author, 0)).rejects.toThrow(
        "invalidFile",
      );
      expect(await f.snapshots.head()).toBe(head);
      expect(await f.project.placements.get(first.placement.id)).toEqual(first);
      expect((await f.project.spaces.get("target-1")).space.version).toBe(2);
      await f.project.placements.put(second, 1, "second", author, 2);
      const next = await f.snapshots.head();
      expect(await f.project.placements.put(first, null, "first", author, 1)).toEqual(first);
      await expect(f.project.placements.put(first, null, "first", author, 2)).rejects.toThrow("conflict");
      expect(await f.project.placements.get(first.placement.id)).toEqual(second);
      expect((await f.project.spaces.get("target-1")).space.version).toBe(3);
      expect(await f.snapshots.head()).toBe(next);
    } finally {
      await f.close();
    }
  },
  30000,
);
