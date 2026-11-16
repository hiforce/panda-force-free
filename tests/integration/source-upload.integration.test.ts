import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { sourceStageFixture, stageLimits, deferred } from "../support/source-staging.js";
import { uploadBody, captureUploaded } from "../support/source-upload.js";
import { PackageSourceStages } from "../../src/server/packages/staging/service.js";
import { FileSourceStageNamespaces } from "../../src/server/packages/staging/files.js";
import { openSourceStageDatabase } from "../../src/server/packages/staging/database.js";
import { SqliteSourceStages } from "../../src/server/packages/staging/repository.js";
import { dropSourceUpload } from "../../src/server/packages/uploads/files.js";
import type { SourceStageRow } from "../../src/server/packages/staging/records.js";
import type { SourceUploadBody } from "../../src/server/packages/uploads/contracts.js";

test("streamed originals survive restart, capture exact ZIP bytes and release duplicate raw storage only after snapshot durability", async () => {
  const f = await sourceStageFixture();
  try {
    let service = f.service(undefined, 5000);
    const submitted = await service.submit("owner", randomUUID(), f.request()),
      stream = uploadBody(f.archive, 19),
      uploaded = await service.upload("owner", submitted.id, submitted.revision, stream.body);
    expect(uploaded.state).toBe("uploaded");
    expect(stream.state.produced).toBeGreaterThan(1);
    expect(stream.state.cancelled).toBe(0);
    expect(await readFile(join(f.contentRoot, submitted.id, "original.upload"))).toEqual(Buffer.from(f.archive));
    service = f.restart();
    expect(service.read("owner", submitted.id)).toEqual(uploaded);
    const duplicate = uploadBody(f.archive);
    expect(await service.upload("owner", submitted.id, submitted.revision, duplicate.body)).toEqual(uploaded);
    expect(duplicate.state).toEqual({ produced: 0, cancelled: 1 });
    const ready = await service.execute(
      "owner",
      submitted.id,
      uploaded.revision,
      captureUploaded(service, submitted.id),
    );
    expect(ready.state).toBe("ready");
    expect(service.events("owner", submitted.id).map((event) => event.state)).toEqual([
      "reserved",
      "uploading",
      "uploaded",
      "acquiring",
      "writing",
      "ready",
    ]);
    expect((await service.content("owner", submitted.id)).readArchive()).toEqual(f.archive);
    expect(await readdir(join(f.contentRoot, submitted.id))).toEqual([ready.digest + ".source"]);
    expect(ready.reservedBytes).toBe((await stat(join(f.contentRoot, submitted.id, ready.digest + ".source"))).size);
  } finally {
    await f.dispose();
  }
});

test("large originals are consumed in bounded chunks and retain file sizes beyond the old execution package limit", async () => {
  const f = await sourceStageFixture();
  try {
    const limits = {
        ...stageLimits,
        archiveBytes: 4 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024,
        fileBytes: 2 * 1024 * 1024,
      },
      service = new PackageSourceStages("templates", f.store, f.files, limits, f.now, 5000),
      archive = zipSync({ "theme/document.md": [new Uint8Array(1024 * 1024 + 128).fill(65), { level: 0 }] }),
      request = {
        source: {
          kind: "zip-upload",
          name: "large.zip",
          bytes: archive.length,
          sha256: createHash("sha256").update(archive).digest("hex"),
        },
      },
      stage = await service.submit("owner", randomUUID(), request),
      stream = uploadBody(archive, 65536),
      uploaded = await service.upload("owner", stage.id, stage.revision, stream.body);
    expect(uploaded.state).toBe("uploaded");
    expect(stream.state.produced).toBeGreaterThan(16);
    const ready = await service.execute("owner", stage.id, uploaded.revision, captureUploaded(service, stage.id));
    expect(ready.state).toBe("ready");
    expect((await service.content("owner", stage.id)).tree.files[0]!.bytes).toBe(1024 * 1024 + 128);
  } finally {
    await f.dispose();
  }
});

test("incomplete, excessive and changed uploads never publish an original and retain bounded failed reservations", async () => {
  const f = await sourceStageFixture();
  try {
    const service = f.service(undefined, 5000),
      changed = new Uint8Array(f.archive);
    changed[8] = changed[8]! ^ 1;
    for (const [bytes, code] of [
      [f.archive.subarray(0, -1), "sourceChanged"],
      [new Uint8Array([...f.archive, 0]), "sourceTooLarge"],
      [changed, "sourceChanged"],
    ] as const) {
      const stage = await service.submit("owner", randomUUID(), f.request()),
        stream = uploadBody(bytes, 31),
        failed = await service.upload("owner", stage.id, stage.revision, stream.body);
      expect(failed).toMatchObject({ state: "failed", failure: code, reservedBytes: stage.reservedBytes });
      expect(stream.state.cancelled).toBe(1);
      expect(await readdir(join(f.contentRoot, stage.id))).toEqual([]);
    }
    const stage = await service.submit("owner", randomUUID(), f.request()),
      stranger = uploadBody(f.archive);
    await expect(service.upload("stranger", stage.id, stage.revision, stranger.body)).rejects.toThrow("stageNotFound");
    expect(stranger.state).toEqual({ produced: 0, cancelled: 1 });
  } finally {
    await f.dispose();
  }
});

test("cancelling a stalled producer closes the write and removes partial bytes before namespace cleanup", async () => {
  const f = await sourceStageFixture(),
    entered = deferred<void>(),
    later = deferred<IteratorResult<Uint8Array>>();
  try {
    const service = f.service(undefined, 5000),
      stage = await service.submit("owner", randomUUID(), f.request());
    let calls = 0,
      cancelled = 0;
    const body: SourceUploadBody = {
        chunks: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (!calls++) return Promise.resolve({ done: false, value: f.archive.subarray(0, 8) });
                entered.resolve();
                return later.promise;
              },
            };
          },
        },
        cancel() {
          cancelled++;
          later.resolve({ done: true, value: undefined });
        },
      },
      pending = service.upload("owner", stage.id, stage.revision, body);
    await entered.promise;
    expect(service.read("owner", stage.id).state).toBe("uploading");
    const cancelledStage = service.cancel("owner", stage.id, service.read("owner", stage.id).revision);
    expect(await pending).toEqual(cancelledStage);
    expect(cancelled).toBe(1);
    expect(await readdir(join(f.contentRoot, stage.id))).toEqual([]);
    expect(await service.remove("owner", stage.id, cancelledStage.revision)).toMatchObject({
      state: "removed",
      reservedBytes: 0,
    });
  } finally {
    later.resolve({ done: true, value: undefined });
    await f.dispose();
  }
});

test("a durable original recovers after a missing metadata acknowledgement without accepting the obsolete upload claim", async () => {
  const f = await sourceStageFixture();
  try {
    let service = f.service(undefined, 5000);
    const stage = await service.submit("owner", randomUUID(), f.request()),
      claim = f.store.claimUpload("owner", stage.id, stage.revision, f.now(), 1000),
      stream = uploadBody(f.archive);
    if (stage.request.source.kind !== "zip-upload") throw Error("Expected ZIP intent");
    await f.files.upload(stage.id, stage.request.source, stream.body, new AbortController().signal);
    await expect(service.recover("owner", stage.id, claim.stage.revision)).rejects.toThrow("stageBusy");
    f.advance(1001);
    service = f.restart();
    const uploaded = await service.recover("owner", stage.id, claim.stage.revision);
    expect(uploaded.state).toBe("uploaded");
    expect(() => f.store.uploaded("owner", claim, f.now())).toThrow("stageConflict");
    const ready = await service.execute("owner", stage.id, uploaded.revision, captureUploaded(service, stage.id));
    expect(ready.state).toBe("ready");
    expect((await service.content("owner", stage.id)).readArchive()).toEqual(f.archive);
  } finally {
    await f.dispose();
  }
});

test("whole namespace removal runs after raw-original cleanup instead of mistaking it for the same operation", async () => {
  const f = await sourceStageFixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  try {
    class SlowRawDrop extends FileSourceStageNamespaces {
      override dropOriginal(id: string) {
        return f.activity.remove(id, async () => {
          entered.resolve();
          await release.promise;
          await dropSourceUpload(join(f.contentRoot, id));
        });
      }
    }
    const service = f.service(new SlowRawDrop(f.contentRoot, f.activity), 5000),
      stage = await service.submit("owner", randomUUID(), f.request()),
      uploaded = await service.upload("owner", stage.id, stage.revision, uploadBody(f.archive).body),
      capture = service.execute("owner", stage.id, uploaded.revision, captureUploaded(service, stage.id));
    await entered.promise;
    const removal = service.remove("owner", stage.id, service.read("owner", stage.id).revision);
    expect(service.read("owner", stage.id).reservedBytes).toBe(stage.reservedBytes);
    release.resolve();
    await capture;
    expect(await removal).toMatchObject({ state: "removed", reservedBytes: 0 });
    expect(await readdir(f.contentRoot)).toEqual([]);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("the version-one source ledger migrates with exact reservations, policies, origins and audit receipts intact", async () => {
  const f = await sourceStageFixture(),
    path = join(f.root, "legacy.sqlite");
  let upgraded: Database | undefined;
  try {
    const service = f.service(undefined, 5000),
      stage = await service.submit("owner", randomUUID(), f.request());
    await service.execute("owner", stage.id, stage.revision, async () => f.snapshot);
    const rows = f.db.query<SourceStageRow, []>("SELECT * FROM package_source_stages").all(),
      events = f.db.query("SELECT * FROM package_source_stage_events").all(),
      old = new Database(path, { create: true });
    try {
      old.exec(await readFile("tests/fixtures/source-stage-schema-v1.sql", "utf8"));
      old.transaction(() => {
        for (const row of rows)
          old.query("INSERT INTO package_source_stages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
            ...(Object.entries(row)
              .filter(([key]) => key !== "entryPolicy")
              .map(([, value]) => value) as SQLQueryBindings[]),
          );
        for (const event of events)
          old
            .query("INSERT INTO package_source_stage_events VALUES(?,?,?,?,?,?)")
            .run(...Object.values(event as Record<string, SQLQueryBindings>));
      })();
    } finally {
      old.close();
    }
    upgraded = openSourceStageDatabase(path);
    expect(upgraded.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(3);
    expect(upgraded.query("SELECT * FROM package_source_stages").all()).toEqual(
      rows.map((row) => ({ ...row, entryPolicy: "regular-only/v1" })),
    );
    expect(upgraded.query("SELECT * FROM package_source_stage_events").all()).toEqual(events);
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const migrated = new PackageSourceStages(
        "templates",
        new SqliteSourceStages(upgraded),
        f.files,
        stageLimits,
        f.now,
        5000,
      ),
      next = await migrated.submit("owner", randomUUID(), f.request());
    expect((await migrated.content("owner", stage.id)).digest).toBe(f.snapshot.digest);
    expect((await migrated.upload("owner", next.id, next.revision, uploadBody(f.archive).body)).state).toBe("uploaded");
  } finally {
    upgraded?.close();
    await f.dispose();
  }
});
