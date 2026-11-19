import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { CreationQueue } from "../../src/server/creation/storage/queue.js";
test("logical creation identity follows ancestry even when legacy timestamps precede their parent", () => {
  const db = openCreationDatabase(":memory:");
  try {
    const tasks = new CreationTaskRepository(db),
      queue = new CreationQueue(db, tasks),
      root = "ffffffff-ffff-4fff-afff-ffffffffffff",
      legacy = "00000000-0000-4000-a000-000000000001",
      current = randomUUID();
    const base = {
      schema: 1,
      owner: "owner",
      projectId: "project",
      kind: "image",
      target: { treeVersion: 0, parentId: null, locale: "en" },
      inputDigest: "a".repeat(64),
      skillCaptureId: null,
    };
    tasks.create({ ...base, id: root, operationId: randomUUID() }, 100);
    tasks.create({ ...base, id: legacy, operationId: randomUUID(), previousTaskId: root }, 50);
    tasks.create(
      { ...base, id: current, operationId: randomUUID(), previousTaskId: legacy, creationKey: "t:" + root },
      20,
    );
    expect(queue.list("owner")).toHaveLength(1);
    expect(queue.list("owner")[0]!.history!.rootId).toBe(root);
    expect(queue.rounds("owner", current).rootId).toBe(root);
    expect(queue.rounds("owner", current).rounds).toBe(3);
  } finally {
    db.close();
  }
});
