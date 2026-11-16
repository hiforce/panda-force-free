import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { openSourceStageDatabase } from "../../src/server/packages/staging/database.js";
import { SqliteSourceStages } from "../../src/server/packages/staging/repository.js";
import type { SourceStageStore } from "../../src/server/packages/staging/ports.js";
import type { MetadataStore } from "../../src/shared/async-value.js";
import { nativeZipSource } from "../support/native-theme.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

for (const action of ["project", "upload", "poll"] as const) {
  test(`source ingestion drains delayed ${action} metadata and starts no file work after close`, async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-async-ingestion-")),
      db = openSourceStageDatabase(join(root, "fixture.sqlite")),
      entered = deferred(),
      released = deferred(),
      original = new SqliteSourceStages(db);
    let delay = false,
      bodyReads = 0,
      cancelled = 0,
      reads = 0;
    const store: MetadataStore<SourceStageStore> = new Proxy(original, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === (action === "poll" ? "candidates" : "read"))
          return async (...args: unknown[]) => {
            const result = value.apply(target, args);
            if (delay) {
              entered.resolve();
              await released.promise;
            }
            return result;
          };
        return value.bind(target);
      },
    });
    const feature = createPackageSourceStages({ root, store });
    try {
      const source = await nativeZipSource(),
        stage = await feature.templates.submit("owner", randomUUID(), {
          source: {
            kind: "zip-upload",
            name: "native-theme.zip",
            bytes: source.bytes.length,
            sha256:
              source.source.descriptor.origin.kind === "zip-upload"
                ? source.source.descriptor.origin.archiveSha256
                : "",
          },
          selected: source.source.tree.files.map((file) => file.path),
        });
      const ready =
        action === "project"
          ? await feature.templates.execute("owner", stage.id, stage.revision, async () => source.source)
          : stage;
      delay = true;
      let pending: Promise<unknown> | undefined;
      if (action === "project")
        pending = feature.ingestion.project("owner", "templates", stage.id, () => {
          reads++;
        });
      else if (action === "upload")
        pending = feature.ingestion.upload("owner", "templates", stage.id, ready.revision, {
          chunks: {
            async *[Symbol.asyncIterator]() {
              bodyReads++;
              yield source.bytes;
            },
          },
          cancel() {
            cancelled++;
          },
        });
      else feature.ingestion.poll();
      // Attach rejection handling before releasing the deferred database result.
      const result = pending ? pending.catch((error) => error) : Promise.resolve();
      await entered.promise;
      let closed = false;
      const close = feature.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      released.resolve();
      if (pending) expect(await result).toMatchObject({ message: "stageUnavailable" });
      await close;
      expect(reads).toBe(0);
      expect(bodyReads).toBe(0);
      if (action === "upload") expect(cancelled).toBe(1);
      expect(feature.ingestion.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
      expect(original.read("owner", stage.id).state).toBe(action === "project" ? "ready" : "reserved");
    } finally {
      released.resolve();
      await feature.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
