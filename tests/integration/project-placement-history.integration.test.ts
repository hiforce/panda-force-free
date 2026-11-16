import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import {
  ProjectPlacementHistory,
  placementCommitMessage,
  placementEventSummary,
} from "../../src/server/project-content/placement-history.js";
import { encodePlacementRecords, projectPlacementFile } from "../../src/server/project-content/placement-file.js";
import { projectRecordShard } from "../../src/server/project-content/record-shards.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import {
  placementFixture,
  projectPlacementFixture,
  placementAuthor as author,
} from "../support/project-placement-fixture.js";

function shardFile(value: ReturnType<typeof projectPlacementFixture>) {
  return {
    path: projectPlacementFile(value.placement.id),
    content: encodePlacementRecords({
      schema: 1,
      projectId: value.placement.projectId,
      shard: projectRecordShard(value.placement.id),
      placements: [value],
    }),
  };
}

test.concurrent(
  "placement history is compact and survives unavailable historical blobs without inventing full events",
  async () => {
    const f = await placementFixture();
    try {
      const first = projectPlacementFixture(),
        second = projectPlacementFixture(2);
      first.placement.metadata.description = "Large publication metadata. ".repeat(240);
      second.placement.metadata.description = "Revised publication metadata. ".repeat(240);
      first.placement.metadata.subtitle = first.placement.metadata.description;
      second.placement.metadata.subtitle = second.placement.metadata.description;
      await f.project.placements.put(first, null, "first", author);
      const firstCommit = await f.snapshots.head();
      await f.project.placements.put(second, 1, "second", author);
      const head = await f.snapshots.head(),
        rows = await new ProjectPlacementHistory(f.owned).list(first.placement.id, head);
      expect(rows.map((row) => row.summary)).toEqual([placementEventSummary(second), placementEventSummary(first)]);
      expect(JSON.stringify(rows).length).toBeLessThan(2500);
      expect((await f.project.placements.event(first.placement.id, 1)).placement.metadata).toEqual(
        first.placement.metadata,
      );
      for (const commit of [firstCommit, head]) {
        const blob = (await f.snapshots.entries(commit)).find(
          (entry) => entry.path === projectPlacementFile(first.placement.id),
        )!.blob;
        await unlink(join(f.owned.directory, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      }
      const reopened = new ProjectContentProject(f.owned);
      expect(await reopened.placements.history(first.placement.id)).toEqual([
        placementEventSummary(second),
        placementEventSummary(first),
      ]);
      expect(await reopened.placements.get(first.placement.id)).toEqual(second);
      await expect(reopened.placements.event(first.placement.id, 1)).rejects.toThrow();
      await expect(reopened.placements.event(first.placement.id, 3)).rejects.toThrow("notFound");
      await expect(reopened.placements.event(first.placement.id, 0)).rejects.toThrow("invalidFile");
      await expect(reopened.placements.history(first.placement.id, 1001)).rejects.toThrow("invalidFile");
      await expect(reopened.placements.history(first.placement.id, 0)).rejects.toThrow("invalidFile");
      await expect(reopened.placements.history("unknown-placement")).rejects.toThrow("notFound");
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "placement history filters other same-shard changes and retains the captured commit",
  async () => {
    const f = await placementFixture();
    try {
      const first = projectPlacementFixture(),
        shard = projectRecordShard(first.placement.id);
      let otherId = "";
      for (let index = 0; !otherId; index++) {
        const candidate = "collision-" + index;
        if (projectRecordShard(candidate) === shard) otherId = candidate;
      }
      const source = projectDocumentFixture(1, "doc-2"),
        other = projectPlacementFixture(1, otherId);
      await f.project.documents.put(source, null, "other-source", author);
      other.placement.documentId = source.document.id;
      other.placement.revisionId = source.revision.id;
      other.placement.path = "other.md";
      await f.project.placements.put(first, null, "first", author);
      const captured = await f.snapshots.head();
      await f.project.placements.put(other, null, "other", author);
      const second = projectPlacementFixture(2);
      await f.project.placements.put(second, 1, "second", author);
      expect(await f.project.placements.get(otherId)).toEqual(other);
      expect((await f.project.placements.history(first.placement.id)).map((row) => row.placement.version)).toEqual([
        2, 1,
      ]);
      expect((await f.project.placements.history(otherId)).map((row) => row.placement.id)).toEqual([otherId]);
      expect(
        (await new ProjectPlacementHistory(f.owned).list(first.placement.id, captured)).map((row) => row.summary),
      ).toEqual([placementEventSummary(first)]);
      expect(await f.project.placements.event(otherId, 1)).toEqual({ placement: other.placement, ...other.audit });
      expect(
        (await f.snapshots.entries(await f.snapshots.head())).filter((row) => row.path.startsWith("placements/")),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "placement history rejects forged summaries, version gaps and mismatched immutable event hashes",
  async () => {
    for (const kind of ["hash", "header", "gap", "duplicate-trailer", "old-event-hash", "old-event-header"] as const) {
      const f = await placementFixture();
      try {
        const first = projectPlacementFixture(),
          second = projectPlacementFixture(kind === "gap" ? 3 : 2);
        if (kind.startsWith("old-event")) {
          const metadata = placementEventSummary(first);
          if (kind === "old-event-hash") metadata.recordHash = "a".repeat(64);
          else metadata.placement.path = "forged-header.md";
          const message = placementCommitMessage(first).replace(
            /^Panda-Placement-Metadata: .+$/m,
            "Panda-Placement-Metadata: " + Buffer.from(JSON.stringify(metadata)).toString("base64url"),
          );
          await f.project.coordinator.mutate({
            operationId: "forged-original",
            author,
            message,
            changes: [shardFile(first)],
          });
        } else await f.project.placements.put(first, null, "first", author);
        if (kind.startsWith("old-event")) await f.project.placements.put(second, 1, "second", author);
        else {
          let message = placementCommitMessage(second);
          if (kind === "hash" || kind === "header") {
            const metadata = placementEventSummary(second);
            if (kind === "hash") metadata.recordHash = "b".repeat(64);
            else metadata.placement.path = "forged-header.md";
            message = message.replace(
              /^Panda-Placement-Metadata: .+$/m,
              "Panda-Placement-Metadata: " + Buffer.from(JSON.stringify(metadata)).toString("base64url"),
            );
          }
          if (kind === "duplicate-trailer") message += "\nPanda-Placement: unrelated";
          await f.project.coordinator.mutate({ operationId: "forged", author, message, changes: [shardFile(second)] });
        }
        const head = await f.snapshots.head();
        if (kind.startsWith("old-event"))
          await expect(f.project.placements.event(first.placement.id, 1)).rejects.toThrow("invalidFile");
        else await expect(f.project.placements.history(first.placement.id)).rejects.toThrow("invalidFile");
        expect(await f.snapshots.head()).toBe(head);
      } finally {
        await f.close();
      }
    }
  },
  30000,
);
