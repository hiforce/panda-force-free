import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { contentRequestHash } from "../../src/server/project-content/mutation.js";
import {
  navigationOperationShard,
  type ProjectNavigationOperation,
} from "../../src/server/project-content/navigation-operation-file.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";

const author = { name: "Operation author", email: "operations@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-navigation-operation-files-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project-1"),
      project = new ProjectContentProject(owned);
    await project.spaces.put(projectSpaceFixture("space-1", true), null, "library", "library", author);
    return {
      owned,
      project,
      snapshots: new ProjectGitSnapshots(owned),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function reservation(id = "operation-1"): ProjectNavigationOperation {
  return {
    id,
    spaceId: "space-1",
    owner: "owner",
    request: contentRequestHash({ id }),
    documentId: "doc-1",
    createdAt: 100,
    result: null,
  };
}

test.concurrent(
  "navigation reservations survive reopen and cannot change identity or expose an unowned space",
  async () => {
    const f = await fixture();
    try {
      const first = reservation();
      expect(await f.project.navigationOperations.get(first.id)).toBeNull();
      expect(await f.project.navigationOperations.put(first, "reserve", author)).toEqual(first);
      const reopened = new ProjectContentProject(f.owned),
        head = await f.snapshots.head();
      expect(await reopened.navigationOperations.get(first.id)).toEqual(first);
      await expect(reopened.documents.get(first.documentId)).rejects.toThrow("notFound");
      for (const changed of [
        { owner: "another-owner" },
        { request: "a".repeat(64) },
        { documentId: "other-doc" },
        { createdAt: 101 },
      ])
        await expect(
          reopened.navigationOperations.put({ ...first, ...changed }, "change-" + Object.keys(changed)[0], author),
        ).rejects.toThrow("conflict");
      await expect(
        reopened.navigationOperations.put({ ...reservation("foreign"), spaceId: "foreign-space" }, "foreign", author),
      ).rejects.toThrow("invalidFile");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "completed navigation receipts replay their original reservation without rolling back the result",
  async () => {
    const f = await fixture();
    try {
      const first = reservation();
      await f.project.navigationOperations.put(first, "reserve", author);
      await f.project.documents.put(projectDocumentFixture(), null, "document", author);
      const completed = {
        ...first,
        result: {
          id: first.id,
          documentId: first.documentId,
          affectedDocumentIds: [first.documentId],
          treeVersion: 1,
          restoredToRoot: false,
        },
      };
      expect(await f.project.navigationOperations.put(completed, "complete", author)).toEqual(completed);
      const reopened = new ProjectContentProject(f.owned),
        head = await f.snapshots.head();
      expect(await reopened.navigationOperations.put(first, "reserve", author)).toEqual(first);
      expect(await reopened.navigationOperations.get(first.id)).toEqual(completed);
      expect(await reopened.navigationOperations.put(completed, "no-change", author)).toEqual(completed);
      expect(await f.snapshots.head()).toBe(head);
      await expect(reopened.navigationOperations.put(first, "late-reserve", author)).rejects.toThrow("conflict");
      await expect(
        reopened.navigationOperations.put(
          { ...completed, result: { ...completed.result, treeVersion: 2 } },
          "replace-result",
          author,
        ),
      ).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "same-shard reservations merge without overwrites and completed results validate document membership",
  async () => {
    const f = await fixture();
    try {
      const first = reservation(),
        shard = navigationOperationShard(first.id);
      let secondId = "";
      for (let index = 0; index < 10000; index++) {
        const candidate = "collision-" + index;
        if (navigationOperationShard(candidate) === shard) {
          secondId = candidate;
          break;
        }
      }
      expect(secondId).not.toBe("");
      const second = reservation(secondId);
      await Promise.all([
        f.project.navigationOperations.put(first, "reserve-first", author),
        f.project.navigationOperations.put(second, "reserve-second", author),
      ]);
      const reopened = new ProjectContentProject(f.owned);
      expect(await reopened.navigationOperations.get(first.id)).toEqual(first);
      expect(await reopened.navigationOperations.get(second.id)).toEqual(second);
      expect(
        (await f.snapshots.entries(await f.snapshots.head())).filter((entry) =>
          entry.path.startsWith("navigation-operations/"),
        ),
      ).toHaveLength(1);
      const head = await f.snapshots.head();
      await expect(
        f.project.coordinator.transact(
          { operationId: "duplicate-plan", author, message: "Duplicate operation plan", intent: "duplicate-plan" },
          (view) => f.project.navigationOperations.prepareMany(view, [first, first]),
        ),
      ).rejects.toThrow("invalidFile");
      const missing = {
        ...first,
        result: {
          id: first.id,
          documentId: first.documentId,
          affectedDocumentIds: [first.documentId],
          treeVersion: 1,
          restoredToRoot: false,
        },
      };
      await expect(reopened.navigationOperations.put(missing, "missing-document", author)).rejects.toThrow("notFound");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "operation plans capture caller input before I/O and reject results belonging to another space",
  async () => {
    const f = await fixture();
    try {
      const first = reservation(),
        originals = [first];
      await f.project.coordinator.transact(
        {
          operationId: "captured-input",
          author,
          message: "Capture navigation operation",
          intent: contentRequestHash(first),
        },
        async (view) => {
          const preparing = f.project.navigationOperations.prepareMany(view, originals);
          first.owner = "changed-after-call";
          originals.push(reservation("not-in-the-command"));
          return preparing;
        },
      );
      expect((await f.project.navigationOperations.get(first.id))?.owner).toBe("owner");
      expect(await f.project.navigationOperations.get("not-in-the-command")).toBeNull();
      await f.project.documents.put(projectDocumentFixture(), null, "source-document", author);
      await f.project.spaces.put(projectSpaceFixture("other-space"), null, "publication", "other-space", author);
      const other = projectDocumentFixture(1, "foreign-doc");
      other.document.spaceId = "other-space";
      await f.project.documents.put(other, null, "foreign-document", author);
      const head = await f.snapshots.head(),
        forged = {
          ...reservation(),
          result: {
            id: first.id,
            documentId: first.documentId,
            affectedDocumentIds: [first.documentId, other.document.id],
            treeVersion: 1,
            restoredToRoot: false,
          },
        };
      await expect(f.project.navigationOperations.put(forged, "foreign-result", author)).rejects.toThrow("invalidFile");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);
