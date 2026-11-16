import { expect, test } from "bun:test";
import { readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteFileError } from "../../src/shared/connections/remote-files.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { sftpPublicationFixture } from "../support/sftp-publication-fixture.js";

test("delivery schema upgrades preserve frozen plans and snapshots from the local-only version", async () => {
  const f = await sftpPublicationFixture();
  try {
    const prepared = await f.prepare();
    const frozen = f.db.query("SELECT record,request FROM publication_plans WHERE id=?").get(prepared.plan.id);
    f.db
      .exec(`DROP INDEX publications_by_source; ALTER TABLE publication_plans DROP COLUMN sourceProjectId; DROP TABLE publication_successors; DROP TABLE publication_resolutions; DROP TABLE publication_recovery_evidence; DROP TABLE publication_cancellations; DROP TABLE publication_effects; DROP TABLE publication_steps; DROP TABLE publication_confirmations; DROP TABLE publication_observations; DROP INDEX publication_identity;
      ALTER TABLE publication_jobs DROP COLUMN nextRunAt;
      ALTER TABLE publication_plans DROP COLUMN identity; ALTER TABLE publication_plans DROP COLUMN kind;
      UPDATE publication_delivery_schema SET version=1 WHERE id=1;`);
    const upgraded = new PublicationRepository(f.db);
    expect(upgraded.get(prepared.plan.id)).toEqual(prepared);
    expect(f.db.query("SELECT record,request FROM publication_plans WHERE id=?").get(prepared.plan.id)).toEqual(frozen);
    expect(upgraded.snapshot(prepared.plan.id)).toEqual(f.artifact);
    upgraded.queue(f.owner, prepared.plan.id, () => {});
    const lease = upgraded.acquire()!;
    const effect = upgraded.remoteIntent(lease, "probeTarget");
    upgraded.remoteAcknowledged(lease, effect);
    expect(f.db.query<{ version: number }, []>("SELECT version FROM publication_delivery_schema").get()!.version).toBe(
      9,
    );
  } finally {
    f.dispose();
  }
});

test("SFTP freezes and verifies bytes, preserves previous releases and records every remote intent", async () => {
  const f = await sftpPublicationFixture();
  try {
    const first = await f.prepare();
    expect(await f.files.stat("/website")).toBeNull();
    await f.service.publish(f.owner, first.plan.id, first.plan.fingerprint);
    await f.run();
    const published = f.store.get(first.plan.id);
    expect(published.job.phase).toBe("published");
    expect(published.job.receipt?.verification).toBe("sftp-files");
    expect(readFileSync(join(f.root, "website/current/index.html"), "utf8")).toBe(f.content);
    expect(await f.files.stat("/website/.panda-publish.lock")).toBeNull();
    const effects = f.db
      .query<{ operation: string; acknowledgedAt: number | null }, []>(
        "SELECT operation,acknowledgedAt FROM publication_effects",
      )
      .all();
    expect(effects.some((effect) => effect.operation === "activateRelease")).toBe(true);
    expect(effects.every((effect) => effect.acknowledgedAt !== null)).toBe(true);
    const second = await f.prepare();
    await f.service.publish(f.owner, second.plan.id, second.plan.fingerprint);
    await f.run();
    expect(f.store.get(second.plan.id).job.receipt?.previousRelease).toBe(first.plan.id);
    expect(readdirSync(join(f.root, "website/releases")).sort()).toEqual([first.plan.id, second.plan.id].sort());
    expect(readlinkSync(join(f.root, "website/current"))).toBe(`releases/${second.plan.id}/site`);
  } finally {
    f.dispose();
  }
}, 15000);

test("a failed upload never switches the old site and releases only an acknowledged owned lock", async () => {
  const f = await sftpPublicationFixture();
  try {
    const first = await f.prepare();
    await f.service.publish(f.owner, first.plan.id, first.plan.fingerprint);
    await f.run();
    const next = await f.prepare();
    f.fault((operation, path, stage) => {
      if (stage === "before" && operation === "write" && path.endsWith(next.plan.id + "/site/index.html"))
        throw new RemoteFileError("permissionDenied");
    });
    await f.service.publish(f.owner, next.plan.id, next.plan.fingerprint);
    await f.run();
    expect(f.store.get(next.plan.id).job.phase).toBe("failed");
    expect(f.store.get(next.plan.id).job.error).toBe("remotePermissionDenied");
    expect(readlinkSync(join(f.root, "website/current"))).toBe(`releases/${first.plan.id}/site`);
    expect(await f.files.stat("/website/.panda-publish.lock")).toBeNull();
    const remaining = f.db
      .query<{ operation: string }, []>("SELECT operation FROM publication_effects WHERE acknowledgedAt IS NULL")
      .all();
    expect(remaining).toEqual([{ operation: "uploadFile" }]);
  } finally {
    f.dispose();
  }
}, 15000);

test("a lost activation acknowledgement blocks later jobs and explicit cleanup verifies the active release without replay", async () => {
  const f = await sftpPublicationFixture();
  try {
    const first = await f.prepare(),
      next = await f.prepare();
    f.fault((operation, path, stage) => {
      if (operation === "atomicRename" && path === "/website/current" && stage === "after")
        throw new RemoteFileError("disconnected");
    });
    await f.service.publish(f.owner, first.plan.id, first.plan.fingerprint);
    await f.run();
    expect(f.store.get(first.plan.id).job.phase).toBe("needsAttention");
    await expect(f.service.publish(f.owner, next.plan.id, next.plan.fingerprint)).rejects.toThrow("targetBusy");
    expect(readlinkSync(join(f.root, "website/current"))).toBe(`releases/${first.plan.id}/site`);
    f.fault(() => {});
    await f.service.reconcile(f.owner, first.plan.id);
    await f.run();
    expect(f.store.get(first.plan.id).job.phase).toBe("needsAttention");
    await expect(f.service.recover(f.owner, first.plan.id, "wrong")).rejects.toThrow("conflict");
    await expect(f.service.recover("other", first.plan.id, first.plan.fingerprint)).rejects.toThrow("notFound");
    writeFileSync(join(f.root, "website/current/index.html"), "tampered");
    await f.service.recover(f.owner, first.plan.id, first.plan.fingerprint);
    await f.run();
    expect(f.store.get(first.plan.id).job.phase).toBe("needsAttention");
    expect(await f.files.stat("/website/.panda-publish.lock")).not.toBeNull();
    writeFileSync(join(f.root, "website/current/index.html"), f.content);
    await f.service.recover(f.owner, first.plan.id, first.plan.fingerprint);
    await f.run();
    expect(f.store.get(first.plan.id).job.phase).toBe("published");
    expect(await f.files.stat("/website/.panda-publish.lock")).toBeNull();
    expect(
      f.calls.filter((call) => call.operation === "atomicRename" && call.path === "/website/current"),
    ).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === "write" && call.path.endsWith("/site/index.html"))).toHaveLength(
      1,
    );
  } finally {
    f.dispose();
  }
}, 15000);

test("a takeover only inspects remote state and rejects the old worker's delayed acknowledgement", async () => {
  const f = await sftpPublicationFixture();
  try {
    const prepared = await f.prepare();
    await f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    let now = Date.now();
    const store = new PublicationRepository(f.db, () => now),
      old = store.acquire()!;
    const effect = store.remoteIntent(old, "acquireLock");
    now += 61000;
    const before = f.calls.length;
    await f.run(store);
    expect(store.get(prepared.plan.id).job.phase).toBe("needsAttention");
    expect(() => store.remoteAcknowledged(old, effect)).toThrow("leaseLost");
    expect(
      f.calls.slice(before).every((call) => ["stat", "list", "realpath", "read", "readlink"].includes(call.operation)),
    ).toBe(true);
    expect(await f.files.stat("/website")).toBeNull();
  } finally {
    f.dispose();
  }
});

test("an uncertain lock acquisition is never retried or removed automatically", async () => {
  const f = await sftpPublicationFixture();
  try {
    const prepared = await f.prepare();
    f.fault((operation, path, stage) => {
      if (operation === "symlink" && path.endsWith(".panda-publish.lock") && stage === "after")
        throw new RemoteFileError("disconnected");
    });
    await f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    await f.run();
    expect(f.store.get(prepared.plan.id).job.phase).toBe("needsAttention");
    f.fault(() => {});
    await f.service.recover(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    await f.run();
    expect(f.store.get(prepared.plan.id).job.phase).toBe("needsAttention");
    expect(await f.files.stat("/website/.panda-publish.lock")).not.toBeNull();
    expect(await f.files.stat("/website/current")).toBeNull();
    expect(
      f.calls.filter((call) => call.operation === "symlink" && call.path.endsWith(".panda-publish.lock")),
    ).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

test("scoped file SFTP plans retain Git provenance after restart and recover a lost acknowledgement without uploading again", async () => {
  const f = await sftpPublicationFixture("/website", "files");
  try {
    const prepared = await f.prepare();
    expect(prepared.plan.sourceProjectId).toBe(f.projectId);
    expect(prepared.plan.build.sourceSnapshot).toEqual(f.build.sourceSnapshot);
    expect(await f.service.list(f.owner, f.spaceId, f.projectId)).toEqual([prepared]);
    expect(await f.files.stat("/website")).toBeNull();
    f.fault((operation, path, stage) => {
      if (operation === "atomicRename" && path === "/website/current" && stage === "after")
        throw new RemoteFileError("disconnected");
    });
    await f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    const reopened = new PublicationRepository(f.db);
    await f.run(reopened);
    expect(reopened.get(prepared.plan.id).job.phase).toBe("needsAttention");
    expect(reopened.get(prepared.plan.id).plan).toEqual(prepared.plan);
    f.fault(() => {});
    await f.service.recover(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    await f.run(new PublicationRepository(f.db));
    expect(f.store.get(prepared.plan.id).job.phase).toBe("published");
    expect(
      f.calls.filter((call) => call.operation === "atomicRename" && call.path === "/website/current"),
    ).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === "write" && call.path.endsWith("/site/index.html"))).toHaveLength(
      1,
    );
    expect(readFileSync(join(f.root, "website/current/index.html"), "utf8")).toBe(f.content);
  } finally {
    f.dispose();
  }
});
