import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { FileCreationInputs } from "../../src/server/creation/integration/input-codec.js";
import { creationSignature, creationTask, type CreationTaskRow } from "../../src/server/creation/storage/records.js";
import { SQLiteCreationProgress } from "../../src/server/creation/storage/progress.js";

/** Synthetic historical metadata belongs only to a disposable app fixture; native generation is verified separately. */
export async function seedCreationRounds(fixtureDirectory: string, firstId: string, count = 24) {
  const root = resolve(fixtureDirectory);
  if (!/\/app-fixture-[a-z0-9]+$/i.test(root)) throw Error("Disposable app fixture required");
  const files = (await readdir(root, { recursive: true })).filter((name) => name.endsWith("/creation/tasks.sqlite"));
  for (const relative of files) {
    const db = new Database(join(root, relative), { strict: true });
    try {
      db.exec("PRAGMA busy_timeout=5000;");
      const raw = db.query<CreationTaskRow, [string]>("SELECT * FROM creation_tasks WHERE id=?").get(firstId);
      if (!raw) continue;
      const first = creationTask(raw),
        inputs = new FileCreationInputs(join(dirname(join(root, relative)), "inputs")),
        original = await inputs.read(first.spec);
      if (first.artifact?.kind !== "image") throw Error("Native image fixture required");
      const { creationKey: _key, ...legacy } = first.spec;
      db.query("UPDATE creation_tasks SET spec=?,signature=? WHERE id=?").run(
        JSON.stringify(legacy),
        creationSignature(legacy),
        firstId,
      );
      const ids = [firstId];
      let previous = firstId;
      for (let index = 0; index < count; index++) {
        const id = randomUUID(),
          operationId = randomUUID(),
          requestDigest = createHash("sha256").update(id).digest("hex"),
          snapshot = structuredClone(original);
        snapshot.taskId = id;
        snapshot.requestDigest = requestDigest;
        snapshot.prompt = "Historical revision " + (index + 1);
        snapshot.skills.id = id;
        snapshot.skills.requestBinding = requestDigest;
        const inputDigest = await inputs.put(snapshot),
          spec = { ...legacy, id, operationId, inputDigest, skillCaptureId: id, previousTaskId: previous };
        const artifact = {
          ...first.artifact,
          operationId,
          assetId: "c-" + operationId,
          title: "Historical output " + (index + 1),
        };
        const createdAt = first.createdAt + index + 1;
        const row = {
          ...raw,
          id,
          operationId,
          spec: JSON.stringify(spec),
          signature: creationSignature(spec),
          artifact: JSON.stringify(artifact),
          createdAt,
          updatedAt: createdAt + 1,
        };
        const columns = Object.keys(row);
        if (columns.some((key) => !/^[a-zA-Z]+$/.test(key))) throw Error("Unexpected fixture columns");
        db.query(
          `INSERT INTO creation_tasks(${columns.map((key) => '"' + key + '"').join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(row));
        new SQLiteCreationProgress(db).record(
          { taskId: id, owner: spec.owner, generation: row.generation, token: "fixture" },
          { at: createdAt + 1, generation: row.generation, stage: "message", text: "Historical answer " + (index + 1) },
        );
        ids.push(id);
        previous = id;
      }
      return ids;
    } finally {
      db.close();
    }
  }
  throw Error("Creation fixture was not found");
}
