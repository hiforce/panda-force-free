import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { WorkflowWorker } from "../../src/server/delivery/workflows/worker.js";
import { digest } from "../../src/server/delivery/digest.js";
import type { WorkflowHandler } from "../../src/server/delivery/workflows/ports.js";
import { createTemporaryDirectory } from "./temporary-directory.js";

export function workflowFixture() {
  const root = createTemporaryDirectory("panda-workflow-", { preferMemory: true });
  const db = new Database(join(root, "jobs.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  let now = 100000;
  const store = new WorkflowRepository(db, "x-post", () => now);
  const input = {
    id: randomUUID(),
    projectId: randomUUID(),
    spaceId: randomUUID(),
    connectionId: randomUUID(),
    payload: { posts: ["first", "second", "third"] },
  };
  const record = store.prepare("owner", digest("identity"), input);
  const queue = () => store.queue("owner", input.id, record.plan.fingerprint, () => {});
  return {
    db,
    root,
    store,
    input,
    record,
    queue,
    advance: (milliseconds = 61000) => {
      now += milliseconds;
    },
    now: () => now,
    dispose: () => {
      db.close();
      rmSync(root, { force: true, recursive: true });
    },
  };
}
export async function runWorkflow(store: WorkflowRepository, handler: WorkflowHandler) {
  const errors: string[] = [];
  const worker = new WorkflowWorker(store, handler, (error) => errors.push(error));
  worker.wake();
  await worker.idle();
  await worker.stop();
  return errors;
}
