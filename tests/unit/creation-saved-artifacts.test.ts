import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CreationSavedArtifacts } from "../../src/server/creation/integration/saved-artifacts.js";
import type { CreationTaskSpec } from "../../src/server/creation/contracts.js";
test("the actual primary receipt survives restart and later project movement without calling the source writer again", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-saved-artifact-"));
  let writes = 0,
    allowed = true;
  const task: CreationTaskSpec = {
      schema: 1,
      id: randomUUID(),
      owner: "owner",
      projectId: "personal",
      operationId: randomUUID(),
      kind: "document",
      target: { parentId: null, treeVersion: 0, locale: "en" },
      inputDigest: "a".repeat(64),
      skillCaptureId: null,
    },
    artifact = {
      kind: "document" as const,
      projectId: "personal",
      documentId: randomUUID(),
      operationId: task.operationId,
      treeVersion: 1,
    },
    writer = {
      commit: async () => {
        writes++;
        return artifact;
      },
    },
    authorize = async () => {
      if (!allowed) throw Error("Denied");
    };
  try {
    const saved = new CreationSavedArtifacts(root, writer, authorize),
      [one, two] = await Promise.all([saved.commit(task, "b".repeat(64)), saved.commit(task, "b".repeat(64))]);
    expect(one).toEqual(two);
    expect(writes).toBe(1);
    const afterMove = new CreationSavedArtifacts(
      root,
      {
        commit: async () => {
          throw Error("The old source project is no longer the document location");
        },
      },
      authorize,
    );
    expect(await afterMove.commit(task, "b".repeat(64))).toEqual(artifact);
    expect(await afterMove.read("owner", task.id)).toEqual(artifact);
    await expect(afterMove.commit(task, "c".repeat(64))).rejects.toThrow("conflict");
    expect(await afterMove.read("other", task.id)).toBeNull();
    allowed = false;
    await expect(afterMove.read("owner", task.id)).rejects.toThrow("Denied");
    await expect(afterMove.commit(task, "b".repeat(64))).rejects.toThrow("Denied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a saved primary is durably recorded before a newly revoked caller can receive or reuse its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-saved-revocation-"));
  let allowed = true,
    writes = 0;
  const task: CreationTaskSpec = {
      schema: 1,
      id: randomUUID(),
      owner: "owner",
      projectId: "project",
      operationId: randomUUID(),
      kind: "document",
      target: { parentId: null, treeVersion: 0, locale: "en" },
      inputDigest: "a".repeat(64),
      skillCaptureId: null,
    },
    artifact = {
      kind: "document" as const,
      projectId: "project",
      documentId: randomUUID(),
      operationId: task.operationId,
      treeVersion: 1,
    },
    authorize = async () => {
      if (!allowed) throw Error("Denied");
    },
    cache = new CreationSavedArtifacts(
      root,
      {
        commit: async () => {
          writes++;
          allowed = false;
          return artifact;
        },
      },
      authorize,
    );
  try {
    await expect(cache.commit(task, "b".repeat(64))).rejects.toThrow("Denied");
    allowed = true;
    expect(await cache.commit(task, "b".repeat(64))).toEqual(artifact);
    expect(writes).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
