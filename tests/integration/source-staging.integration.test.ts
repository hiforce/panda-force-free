import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { SourceError, type SourceLimits } from "../../src/shared/packages/sources/contracts.js";
import { FileSourceStageNamespaces } from "../../src/server/packages/staging/files.js";
import { SqliteSourceStages } from "../../src/server/packages/staging/repository.js";
import { openSourceStageDatabase } from "../../src/server/packages/staging/database.js";
import { PackageSourceStages } from "../../src/server/packages/staging/service.js";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { sourceStageFixture, stageLimits, deferred } from "../support/source-staging.js";

test("lower admission limits after restart do not hide existing reservations or prevent cleanup", async () => {
  const f = await sourceStageFixture();
  try {
    const initial = f.service(),
      operation = randomUUID(),
      stage = await initial.submit("owner", operation, f.request()),
      ready = await initial.execute("owner", stage.id, stage.revision, async () => f.snapshot),
      narrowed = { ...stageLimits, archiveBytes: 1, files: 1 },
      service = new PackageSourceStages(
        "templates",
        new SqliteSourceStages(f.db),
        new FileSourceStageNamespaces(f.contentRoot, f.activity),
        narrowed,
        f.now,
      );
    expect(service.read("owner", stage.id).request).toEqual(stage.request);
    expect(service.list("owner").map((value) => value.id)).toEqual([stage.id]);
    expect((await service.content("owner", stage.id)).digest).toBe(f.snapshot.digest);
    expect(await service.submit("owner", operation, f.request())).toEqual(ready);
    await expect(service.submit("owner", randomUUID(), f.request())).rejects.toThrow("stageInvalidInput");
    expect(await service.remove("owner", stage.id, ready.revision)).toMatchObject({
      state: "removed",
      reservedBytes: 0,
    });
    expect(await readdir(f.contentRoot)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("an accepted operation still replays its original receipt after admission policy changes", async () => {
  const f = await sourceStageFixture();
  try {
    const operation = randomUUID(),
      stage = await f.service().submit("owner", operation, f.request()),
      narrowed = { ...stageLimits, archiveBytes: 1, files: 1 },
      service = new PackageSourceStages("templates", f.store, f.files, narrowed, f.now);
    expect(await service.submit("owner", operation, f.request())).toEqual(stage);
    expect(await readdir(f.contentRoot)).toEqual([stage.id]);
    const ready = await service.execute(
      "owner",
      stage.id,
      stage.revision,
      async (_actor, _purpose, _request, _signal, limits) => {
        expect(limits).toEqual(stage.limits);
        expect(Object.isFrozen(limits)).toBe(true);
        return f.snapshot;
      },
    );
    expect(ready.state).toBe("ready");
    expect((await service.content("owner", stage.id)).digest).toBe(f.snapshot.digest);
  } finally {
    await f.dispose();
  }
});

test("feature shutdown settles source acquisition before closing metadata and keeps both purposes independently owned", async () => {
  const f = await sourceStageFixture(),
    root = join(f.root, "feature"),
    feature = createPackageSourceStages({ root, limits: stageLimits }),
    entered = deferred<void>(),
    later = deferred<typeof f.snapshot>();
  try {
    const stage = await feature.templates.submit("owner", randomUUID(), f.request()),
      skill = await feature.skills.submit("owner", randomUUID(), f.request()),
      execution = feature.templates.execute("owner", stage.id, 1, async () => {
        entered.resolve();
        return later.promise;
      });
    await entered.promise;
    expect(() => feature.skills.read("owner", stage.id)).toThrow("stageNotFound");
    const close = feature.close();
    expect(feature.close()).toBe(close);
    expect(await execution).toMatchObject({ state: "failed", failure: "sourceCancelled" });
    await close;
    later.resolve(f.snapshot);
    await expect(feature.templates.submit("owner", randomUUID(), f.request())).rejects.toThrow("stageUnavailable");
    const reopened = createPackageSourceStages({ root, limits: stageLimits });
    try {
      expect(reopened.templates.read("owner", stage.id)).toMatchObject({ state: "failed", failure: "sourceCancelled" });
      expect(reopened.skills.read("owner", skill.id).state).toBe("reserved");
      expect(reopened.templates.list("owner")).toHaveLength(1);
      expect(reopened.skills.list("owner")).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  } finally {
    later.resolve(f.snapshot);
    await feature.close();
    await f.dispose();
  }
});

test("shutdown waits for namespace cleanup to finish its receipt before metadata can close", async () => {
  const f = await sourceStageFixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  try {
    class SlowCleanup extends FileSourceStageNamespaces {
      override async remove(id: string) {
        entered.resolve();
        await release.promise;
        await super.remove(id);
      }
    }
    const service = f.service(new SlowCleanup(f.contentRoot, f.activity)),
      stage = await service.submit("owner", randomUUID(), f.request()),
      removal = service.remove("owner", stage.id, stage.revision);
    await entered.promise;
    let closed = false;
    const closing = service.shutdown().then(() => {
      closed = true;
    });
    await expect(service.submit("owner", randomUUID(), f.request())).rejects.toThrow("stageUnavailable");
    expect(closed).toBe(false);
    release.resolve();
    expect(await removal).toMatchObject({ state: "removed", reservedBytes: 0 });
    await closing;
    expect(closed).toBe(true);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test.each(["write", "read"] as const)(
  "a shared file owner waits for open %s handles before returning reserved capacity",
  async (mode) => {
    const f = await sourceStageFixture({
        ownerBytes: 64 * 1024 * 1024,
        globalBytes: 128 * 1024 * 1024,
        ownerItems: 1,
        globalItems: 2,
      }),
      entered = deferred<void>(),
      release = deferred<void>();
    let writing: Promise<void> | undefined;
    try {
      const service = f.service(),
        stage = await service.submit("owner", randomUUID(), f.request()),
        claim = f.store.claim("owner", stage.id, stage.revision, f.now(), 10000),
        bound = f.store.bind("owner", claim, f.snapshot.digest, f.now()),
        path = join(f.contentRoot, stage.id, "inflight.tmp");
      if (mode === "read") await writeFile(path, new Uint8Array(1024).fill(1));
      const hold = async () => {
        const file = await open(path, mode === "write" ? "wx" : "r");
        try {
          if (mode === "write") await file.writeFile(new Uint8Array(1024).fill(1));
          else expect((await file.readFile()).length).toBe(1024);
          entered.resolve();
          await release.promise;
          if (mode === "write") await file.writeFile(new Uint8Array(1024).fill(2));
          else expect((await file.read(new Uint8Array(1), 0, 1, 0)).bytesRead).toBe(1);
        } finally {
          await file.close();
        }
      };
      writing = mode === "write" ? f.activity.write(stage.id, hold) : f.activity.read(stage.id, hold);
      await entered.promise;
      const peer = f.service(new FileSourceStageNamespaces(f.contentRoot, f.activity)),
        removing = peer.remove("owner", stage.id, bound.revision);
      expect(peer.read("owner", stage.id)).toMatchObject({ state: "removing", reservedBytes: stage.reservedBytes });
      expect((await stat(path)).size).toBe(1024);
      await expect(service.submit("owner", randomUUID(), f.request())).rejects.toThrow("stageCapacity");
      let lateRan = false;
      await expect(
        f.activity.write(stage.id, async () => {
          lateRan = true;
        }),
      ).rejects.toThrow("stageConflict");
      expect(lateRan).toBe(false);
      release.resolve();
      await writing;
      expect(await removing).toMatchObject({ state: "removed", reservedBytes: 0 });
      await expect(stat(join(f.contentRoot, stage.id))).rejects.toThrow();
      expect((await service.submit("owner", randomUUID(), f.request())).state).toBe("reserved");
    } finally {
      release.resolve();
      await writing?.catch(() => {});
      await f.dispose();
    }
  },
);

test("namespace preparation failures roll back reservations and failed deletion remains recoverable without returning capacity early", async () => {
  const f = await sourceStageFixture({
    ownerBytes: 64 * 1024 * 1024,
    globalBytes: 128 * 1024 * 1024,
    ownerItems: 1,
    globalItems: 2,
  });
  try {
    class BrokenPreparation extends FileSourceStageNamespaces {
      override prepare() {
        throw Error("PRIVATE_STORAGE_PATH");
      }
    }
    await expect(
      f.service(new BrokenPreparation(f.contentRoot, f.activity)).submit("owner", randomUUID(), f.request()),
    ).rejects.toThrow("stageUnavailable");
    expect(f.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM package_source_stages").get()!.count).toBe(
      0,
    );
    expect(await readdir(f.contentRoot)).toEqual([]);
    class BrokenDeletion extends FileSourceStageNamespaces {
      override async remove() {
        throw Error("PRIVATE_STORAGE_PATH");
      }
    }
    const service = f.service(new BrokenDeletion(f.contentRoot, f.activity)),
      submitted = await service.submit("owner", randomUUID(), f.request());
    await expect(service.remove("owner", submitted.id, submitted.revision)).rejects.toThrow("stageUnavailable");
    const removing = service.read("owner", submitted.id);
    expect(removing.state).toBe("removing");
    expect(removing.reservedBytes).toBe(submitted.reservedBytes);
    await expect(service.submit("owner", randomUUID(), f.request())).rejects.toThrow("stageCapacity");
    const restarted = f.restart(),
      removed = await restarted.remove("owner", submitted.id, removing.revision);
    expect(removed).toMatchObject({ state: "removed", reservedBytes: 0 });
    expect(await readdir(f.contentRoot)).toEqual([]);
    expect((await restarted.submit("owner", randomUUID(), f.request())).state).toBe("reserved");
  } finally {
    await f.dispose();
  }
});

test("source stages retain file-backed results, operation receipts and audit history after restart without repeating acquisition", async () => {
  const f = await sourceStageFixture();
  try {
    let service = f.service(),
      calls = 0;
    const operation = randomUUID(),
      submitted = await service.submit("owner", operation, f.request());
    expect(submitted.state).toBe("reserved");
    expect(await readdir(join(f.contentRoot, submitted.id))).toEqual([]);
    const ready = await service.execute(
      "owner",
      submitted.id,
      submitted.revision,
      async (actor, purpose, request, signal) => {
        expect(actor).toBe("owner");
        expect(purpose).toBe("templates");
        expect(request).toEqual(submitted.request);
        expect(signal.aborted).toBe(false);
        calls++;
        return f.snapshot;
      },
    );
    expect(ready.state).toBe("ready");
    expect(ready.reservedBytes).toBe(f.files.size(f.snapshot));
    expect((await stat(join(f.contentRoot, submitted.id, f.snapshot.digest + ".source"))).size).toBe(
      ready.reservedBytes,
    );
    expect(ready.reservedBytes).toBeLessThan(submitted.reservedBytes);
    expect(ready.origin).toEqual(f.snapshot.descriptor.origin);
    expect(
      (
        await service.execute("owner", submitted.id, 1, async () => {
          calls++;
          throw Error("Must not run");
        })
      ).digest,
    ).toBe(f.snapshot.digest);
    service = f.restart();
    expect(await service.submit("owner", operation, f.request())).toEqual(ready);
    expect(calls).toBe(1);
    expect((await service.content("owner", submitted.id)).readArchive()).toEqual(f.archive);
    expect(service.events("owner", submitted.id).map((event) => [event.revision, event.state])).toEqual([
      [1, "reserved"],
      [2, "acquiring"],
      [3, "writing"],
      [4, "ready"],
    ]);
    expect(Object.keys(ready)).not.toContain("token");
    expect(() => service.read("stranger", submitted.id)).toThrow("stageNotFound");
    expect(() => f.service(undefined, 1000, "skills").read("owner", submitted.id)).toThrow("stageNotFound");
    expect(service.list("owner")).toHaveLength(1);
    const rows = f.db
      .query<{ request: string; origin: string }, []>("SELECT request,origin FROM package_source_stages")
      .all();
    expect(JSON.stringify(rows)).not.toContain("Private original theme body");
    expect(await readdir(join(f.contentRoot, submitted.id))).toEqual([f.snapshot.digest + ".source"]);
    const removed = await service.remove("owner", submitted.id, ready.revision);
    expect(await service.submit("owner", operation, f.request())).toEqual(removed);
    await expect(stat(join(f.contentRoot, submitted.id))).rejects.toThrow();
    expect(service.list("owner")).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("reservations serialize across independent metadata connections and reject conflicting retries before source IO", async () => {
  const capacity = { ownerBytes: 64 * 1024 * 1024, globalBytes: 128 * 1024 * 1024, ownerItems: 1, globalItems: 2 },
    f = await sourceStageFixture(capacity),
    otherDb = openSourceStageDatabase(f.database),
    other = new PackageSourceStages(
      "templates",
      new SqliteSourceStages(otherDb, capacity),
      new FileSourceStageNamespaces(f.contentRoot, f.activity),
      stageLimits,
      f.now,
    );
  try {
    const services = [f.service(), other],
      results = await Promise.allSettled(services.map((service) => service.submit("owner", randomUUID(), f.request())));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.message : "").toBe("stageCapacity");
    expect(await readdir(f.contentRoot)).toHaveLength(1);
    const operation = randomUUID(),
      second = await other.submit("second", operation, f.request());
    expect(await other.submit("second", operation, f.request())).toEqual(second);
    await expect(other.submit("second", operation, f.request([]))).rejects.toThrow("stageConflict");
    await expect(other.submit("third", randomUUID(), f.request())).rejects.toThrow("stageCapacity");
    expect(await readdir(f.contentRoot)).toHaveLength(2);
  } finally {
    otherDb.close();
    await f.dispose();
  }
});

test("removal holds its reservation until durable namespace cleanup and fences an already claimed late writer", async () => {
  const f = await sourceStageFixture({
    ownerBytes: 64 * 1024 * 1024,
    globalBytes: 128 * 1024 * 1024,
    ownerItems: 1,
    globalItems: 2,
  });
  try {
    const entered = deferred<void>(),
      release = deferred<void>(),
      deleting = deferred<void>(),
      deleteRelease = deferred<void>();
    class DelayedFiles extends FileSourceStageNamespaces {
      override async put(id: string, source: typeof f.snapshot, limits: SourceLimits) {
        entered.resolve();
        await release.promise;
        await super.put(id, source, limits);
      }
      override async remove(id: string) {
        deleting.resolve();
        await deleteRelease.promise;
        await super.remove(id);
      }
    }
    const service = f.service(new DelayedFiles(f.contentRoot, f.activity)),
      submitted = await service.submit("owner", randomUUID(), f.request()),
      running = service.execute("owner", submitted.id, 1, async () => f.snapshot);
    await entered.promise;
    expect(service.read("owner", submitted.id).state).toBe("writing");
    const removing = service.remove("owner", submitted.id, service.read("owner", submitted.id).revision);
    await deleting.promise;
    expect(service.read("owner", submitted.id).state).toBe("removing");
    expect(service.read("owner", submitted.id).reservedBytes).toBe(submitted.reservedBytes);
    await expect(service.submit("owner", randomUUID(), f.request())).rejects.toThrow("stageCapacity");
    deleteRelease.resolve();
    const removed = await removing;
    expect(removed.state).toBe("removed");
    expect(removed.reservedBytes).toBe(0);
    const fresh = await service.submit("owner", randomUUID(), f.request());
    release.resolve();
    expect((await running).state).toBe("removed");
    await expect(stat(join(f.contentRoot, submitted.id))).rejects.toThrow();
    expect(await readdir(f.contentRoot)).toEqual([fresh.id]);
    expect(service.read("owner", submitted.id)).toEqual(removed);
    expect(service.list("owner").map((stage) => stage.id)).toEqual([fresh.id]);
  } finally {
    await f.dispose();
  }
});

test("cancelled acquisition cannot publish a late result and provider failures persist stable codes without secrets", async () => {
  const f = await sourceStageFixture();
  try {
    const service = f.service(),
      entered = deferred<void>(),
      result = deferred<typeof f.snapshot>(),
      submitted = await service.submit("owner", randomUUID(), f.request()),
      pending = service.execute("owner", submitted.id, 1, async () => {
        entered.resolve();
        return result.promise;
      });
    await entered.promise;
    const cancelled = service.cancel("owner", submitted.id, service.read("owner", submitted.id).revision);
    expect((await pending).state).toBe("cancelled");
    expect(cancelled.reservedBytes).toBe(submitted.reservedBytes);
    await service.remove("owner", submitted.id, cancelled.revision);
    result.resolve(f.snapshot);
    const failed = await service.submit("owner", randomUUID(), f.request()),
      outcome = await service.execute("owner", failed.id, 1, async () => {
        throw Error("PRIVATE_TOKEN_MUST_NOT_PERSIST");
      });
    expect(outcome.state).toBe("failed");
    expect(outcome.failure).toBe("sourceUnavailable");
    expect(await readdir(join(f.contentRoot, failed.id))).toEqual([]);
    expect(JSON.stringify(f.db.query("SELECT * FROM package_source_stages").all())).not.toContain(
      "PRIVATE_TOKEN_MUST_NOT_PERSIST",
    );
    const denied = await service.submit("owner", randomUUID(), f.request()),
      deniedResult = await service.execute("owner", denied.id, 1, async () => {
        throw new SourceError("sourceAccessDenied");
      });
    expect(deniedResult.failure).toBe("sourceAccessDenied");
  } finally {
    await f.dispose();
  }
});

test("recovery verifies durable bytes after an interrupted commit and fences both live and obsolete claims", async () => {
  const f = await sourceStageFixture();
  try {
    let service = f.service();
    const stage = await service.submit("owner", randomUUID(), f.request()),
      claim = f.store.claim("owner", stage.id, 1, f.now(), 10000),
      writing = f.store.bind("owner", claim, f.snapshot.digest, f.now());
    await f.files.put(stage.id, f.snapshot, stage.limits);
    await expect(service.recover("owner", stage.id, writing.revision)).rejects.toThrow("stageBusy");
    f.advance(10001);
    service = f.restart();
    const ready = await service.recover("owner", stage.id, writing.revision);
    expect(ready.state).toBe("ready");
    expect((await service.content("owner", stage.id)).digest).toBe(f.snapshot.digest);
    expect(service.events("owner", stage.id).map((event) => event.state)).toEqual([
      "reserved",
      "acquiring",
      "writing",
      "failed",
      "ready",
    ]);
    expect(() => f.store.complete("owner", claim, f.snapshot, f.files.size(f.snapshot), f.now())).toThrow(
      "stageConflict",
    );
    expect(service.read("owner", stage.id)).toEqual(ready);
    const broken = await service.submit("owner", randomUUID(), f.request()),
      brokenClaim = f.store.claim("owner", broken.id, 1, f.now(), 10000),
      brokenWrite = f.store.bind("owner", brokenClaim, f.snapshot.digest, f.now());
    await f.files.put(broken.id, f.snapshot, broken.limits);
    const path = join(f.contentRoot, broken.id, f.snapshot.digest + ".source"),
      bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    f.advance(10001);
    await expect(service.recover("owner", broken.id, brokenWrite.revision)).rejects.toThrow("sourceChanged");
    expect(service.read("owner", broken.id).state).toBe("failed");
    expect(service.read("owner", broken.id).reservedBytes).toBe(broken.reservedBytes);
    expect(await service.remove("owner", broken.id, service.read("owner", broken.id).revision)).toMatchObject({
      state: "removed",
      reservedBytes: 0,
    });
  } finally {
    await f.dispose();
  }
});

test("source mismatches and timeouts fail before body ownership while expired acquisition becomes explicitly interrupted", async () => {
  const f = await sourceStageFixture();
  try {
    const service = f.service(),
      subset = await service.submit("owner", randomUUID(), f.request([])),
      mismatched = await service.execute("owner", subset.id, 1, async () => f.snapshot);
    expect(mismatched.failure).toBe("sourceChanged");
    expect(await readdir(join(f.contentRoot, subset.id))).toEqual([]);
    const fast = f.service(undefined, 50),
      timed = await fast.submit("owner", randomUUID(), f.request()),
      late = deferred<typeof f.snapshot>(),
      timeout = await fast.execute("owner", timed.id, 1, () => late.promise);
    expect(timeout.state).toBe("failed");
    expect(timeout.failure).toBe("sourceTimedOut");
    late.resolve(f.snapshot);
    const abandoned = await service.submit("owner", randomUUID(), f.request());
    f.store.claim("owner", abandoned.id, 1, f.now(), 100);
    f.advance(101);
    const interrupted = await f.restart().recover("owner", abandoned.id, 2);
    expect(interrupted).toMatchObject({ state: "failed", failure: "interrupted", digest: null });
  } finally {
    await f.dispose();
  }
});
