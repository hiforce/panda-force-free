import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectionRepository } from "../../src/server/connections/repository.js";
import { ConnectionService } from "../../src/server/connections/service.js";
import { ConnectionRegistry } from "../../src/server/connections/registry.js";
import { localConnector } from "../../src/server/connections/adapters/local-connector.js";
import { LocalTargets } from "../../src/server/connections/adapters/local-targets.js";
import { publicationOwner } from "../../src/server/connections/integration/identity.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { PublicationService } from "../../src/server/delivery/service.js";
import { PublicationWorker } from "../../src/server/delivery/worker.js";
import { LocalSiteDelivery } from "../../src/server/delivery/adapters/local-site.js";
import { digest, verifiedArtifact } from "../../src/server/delivery/validation.js";
import { DeliveryError } from "../../src/server/delivery/errors.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";

function fixture() {
  const root = createTemporaryDirectory("panda-publication-", { preferMemory: true }),
    targetsRoot = join(root, "targets"),
    source = join(root, "source"),
    projectId = randomUUID(),
    spaceId = randomUUID(),
    owner = "owner",
    db = new Database(join(root, "state.sqlite"), { create: true });
  mkdirSync(targetsRoot);
  mkdirSync(source);
  db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;");
  const targets = new LocalTargets([{ id: "local", path: targetsRoot }], () => [source]);
  const connections = new ConnectionService(
    new ConnectionRepository(db),
    new ConnectionRegistry([localConnector(targets)]),
    (id) => {
      if (id !== projectId) throw new Error("Missing project");
    },
  );
  const bytes = Buffer.from("<h1>Frozen site</h1>"),
    artifact = {
      protocol: 1 as const,
      files: [{ path: "index.html", data: bytes.toString("base64"), sha256: digest(bytes) }],
      bytes: bytes.length,
    };
  const build = {
    id: randomUUID(),
    site: { title: "Fixture", url: "https://example.com", basePath: "/", locale: "en" },
    engine: "hexo" as const,
    inputHash: digest("input"),
    sources: [],
    image: null,
  };
  const sources = {
    authorize: (id: string) => {
      if (id !== spaceId) throw new Error("Missing space");
      return { assertCurrent() {}, assertDestination() {} };
    },
    capture: async () => ({ projectId, spaceId, build, artifact }),
  };
  const store = new PublicationRepository(db),
    service = new PublicationService(sources, connections, store, () => {});
  const input = {
    id: randomUUID(),
    projectId,
    name: "Fixture destination",
    connector: "local-site",
    root: "local",
    directory: "fixture",
    publicUrl: "https://example.com/",
  };
  return {
    root,
    targetsRoot,
    source,
    targets,
    projectId,
    spaceId,
    owner,
    db,
    connections,
    store,
    service,
    input,
    artifact,
    build,
    dispose: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("connection ownership, idempotence, version changes and target path protections are independent of model accounts", async () => {
  const f = fixture();
  try {
    const created = await f.connections.create(f.owner, f.input);
    expect(await f.connections.create(f.owner, f.input)).toEqual(created);
    expect(f.connections.list("other", f.projectId)).toEqual([]);
    expect(() => f.connections.owned("other", created.id)).toThrow("notFound");
    expect(f.connections.roots()[0]!.path).toBe(f.targetsRoot);
    await expect(
      f.connections.create(f.owner, { ...f.input, id: randomUUID(), directory: "fixture/nested" }),
    ).rejects.toThrow("targetInUse");
    await expect(
      f.connections.create(f.owner, { ...f.input, id: randomUUID(), directory: "../source" }),
    ).rejects.toThrow("invalidPath");
    await expect(f.connections.create(f.owner, { ...f.input, ownerId: "other" })).rejects.toThrow("invalidInput");
    mkdirSync(join(f.targetsRoot, "existing"));
    writeFileSync(join(f.targetsRoot, "existing", "keep.txt"), "untouched");
    await expect(
      f.connections.create(f.owner, { ...f.input, id: randomUUID(), directory: "existing" }),
    ).rejects.toThrow("targetInUse");
    symlinkSync(f.source, join(f.targetsRoot, "symlink"));
    await expect(
      f.connections.create(f.owner, { ...f.input, id: randomUUID(), directory: "symlink/site" }),
    ).rejects.toThrow("invalidPath");
    const testResult = await f.connections.test(f.owner, created.id, created.version);
    expect(testResult.capabilities).toEqual(["site.publish"]);
    expect(readdirSync(join(f.targetsRoot, "fixture"))).toEqual([".panda-site.json"]);
    const updated = f.connections.update(f.owner, created.id, {
      version: 1,
      name: "Renamed",
      enabled: false,
      publicUrl: created.publicUrl,
    });
    expect(updated.version).toBe(2);
    expect(() =>
      f.connections.update(f.owner, created.id, {
        version: 1,
        name: "Stale",
        enabled: true,
        publicUrl: created.publicUrl,
      }),
    ).toThrow("conflict");
    expect(readFileSync(join(f.targetsRoot, "existing", "keep.txt"), "utf8")).toBe("untouched");
    expect(() => publicationOwner({ administrator: null }, { idaasSession: null })).toThrow("identityRequired");
    const identity = { uuid: "person", tenantId: "tenant", account: "display" };
    const first = publicationOwner(
      { administrator: null },
      { idaasSession: { id: "session", identity, expiresAt: 1 } },
    );
    expect(
      publicationOwner(
        { administrator: null },
        { idaasSession: { id: "new", identity: { ...identity, account: "renamed" }, expiresAt: 2 } },
      ),
    ).toBe(first);
    expect(
      publicationOwner(
        { administrator: null },
        { idaasSession: { id: "new", identity: { ...identity, tenantId: "other" }, expiresAt: 2 } },
      ),
    ).not.toBe(first);
  } finally {
    f.dispose();
  }
});

test("publication freezes bytes, requires explicit authorization, survives reopen and activates exactly one release", async () => {
  const f = fixture();
  let worker: PublicationWorker | undefined;
  try {
    const connection = await f.connections.create(f.owner, f.input),
      request = { id: randomUUID(), buildId: f.build.id, connectionId: connection.id, connectionVersion: 1 };
    const prepared = await f.service.prepare(f.owner, request);
    expect(prepared.job.phase).toBe("prepared");
    expect(readdirSync(f.targetsRoot)).toEqual([]);
    expect((await f.service.prepare(f.owner, request)).plan.fingerprint).toBe(prepared.plan.fingerprint);
    await expect(f.service.publish(f.owner, request.id, "wrong")).rejects.toThrow("conflict");
    await expect(f.service.publish("other", request.id, prepared.plan.fingerprint)).rejects.toThrow("notFound");
    f.artifact.files[0]!.data = Buffer.from("changed source").toString("base64");
    expect((await f.service.publish(f.owner, request.id, prepared.plan.fingerprint)).job.phase).toBe("queued");
    expect((await f.service.publish(f.owner, request.id, prepared.plan.fingerprint)).job.phase).toBe("queued");
    const reopened = new PublicationRepository(f.db);
    worker = new PublicationWorker(
      reopened,
      () => new LocalSiteDelivery(f.targets),
      (actor, plan) => f.service.assertExecutable(actor, plan),
      () => {},
    );
    worker.wake();
    await worker.idle();
    const published = await f.service.detail(f.owner, request.id);
    expect(published.job.phase).toBe("published");
    expect(published.job.receipt?.releaseId).toBe(request.id);
    expect(readFileSync(join(f.targetsRoot, "fixture", "current", "index.html"), "utf8")).toBe("<h1>Frozen site</h1>");
    expect(readlinkSync(join(f.targetsRoot, "fixture", "current"))).toBe(`releases/${request.id}/site`);
    expect(readdirSync(join(f.targetsRoot, "fixture", "releases"))).toEqual([request.id]);
    expect(f.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_snapshots").get()!.total).toBe(
      0,
    );
    expect((await f.service.publish(f.owner, request.id, prepared.plan.fingerprint)).job.receipt).toEqual(
      published.job.receipt,
    );
  } finally {
    await worker?.stop();
    f.dispose();
  }
});

test("publication plans reject stale targets and invalid artifacts and cancel without touching directories", async () => {
  const f = fixture();
  try {
    const connection = await f.connections.create(f.owner, f.input),
      request = { id: randomUUID(), buildId: f.build.id, connectionId: connection.id, connectionVersion: 1 };
    const prepared = await f.service.prepare(f.owner, request);
    f.connections.update(f.owner, connection.id, {
      version: 1,
      enabled: true,
      name: "Changed",
      publicUrl: connection.publicUrl,
    });
    await expect(f.service.publish(f.owner, request.id, prepared.plan.fingerprint)).rejects.toThrow(
      "connectionChanged",
    );
    expect((await f.service.cancel(f.owner, request.id)).job.phase).toBe("cancelled");
    expect(readdirSync(f.targetsRoot)).toEqual([]);
    await expect(f.service.prepare(f.owner, { ...request, id: randomUUID() })).rejects.toThrow("connectionChanged");
    f.build.site.basePath = "/other/";
    await expect(f.service.prepare(f.owner, { ...request, id: randomUUID(), connectionVersion: 2 })).rejects.toThrow(
      "siteUrlMismatch",
    );
    expect(() =>
      verifiedArtifact({ ...f.artifact, files: [{ ...f.artifact.files[0], sha256: "0".repeat(64) }] }),
    ).toThrow("artifactInvalid");
    expect(() =>
      verifiedArtifact({ ...f.artifact, files: [{ ...f.artifact.files[0], path: "../index.html" }] }),
    ).toThrow("artifactInvalid");
  } finally {
    f.dispose();
  }
});

test("lease loss fences stale side effects and a restarted worker reconciles activation after a lost acknowledgement", async () => {
  const f = fixture();
  let clock = Date.now(),
    worker: PublicationWorker | undefined;
  const second = new Database(join(f.root, "state.sqlite"));
  try {
    const connection = await f.connections.create(f.owner, f.input),
      request = { id: randomUUID(), buildId: f.build.id, connectionId: connection.id, connectionVersion: 1 };
    const prepared = await f.service.prepare(f.owner, request);
    const store = new PublicationRepository(f.db, () => clock),
      other = new PublicationRepository(second, () => clock);
    store.queue(f.owner, request.id, () => {});
    const lease = store.acquire()!;
    expect(other.acquire()).toBeNull();
    clock += 61000;
    const takeover = other.acquire()!;
    expect(takeover.fence).toBe(lease.fence + 1);
    let effect = false;
    expect(() =>
      store.guard(lease, () => {
        effect = true;
      }),
    ).toThrow("leaseLost");
    expect(effect).toBe(false);
    const adapter = new LocalSiteDelivery(f.targets);
    await adapter.deliver(prepared.plan, other.snapshot(request.id), {
      fence: takeover.fence,
      remote: async () => {
        throw new Error("Local delivery must not use remote operations");
      },
      run: (step, fn) => {
        other.step(takeover, step);
        return other.guard(takeover, fn);
      },
    });
    expect(other.get(request.id).job.phase).toBe("running");
    expect(other.get(request.id).job.step).toBe("activating");
    clock += 61000;
    worker = new PublicationWorker(
      store,
      () => adapter,
      async () => () => {},
      () => {},
    );
    worker.wake();
    await worker.idle();
    expect(store.get(request.id).job.phase).toBe("published");
    expect(readdirSync(join(f.targetsRoot, "fixture", "releases"))).toEqual([request.id]);
    expect(store.get(request.id).job.receipt?.previousRelease).toBeNull();
  } finally {
    await worker?.stop();
    second.close();
    f.dispose();
  }
});

test("unknown activation blocks new jobs and read-only reconciliation recovers a receipt without republishing", async () => {
  const f = fixture();
  let worker: PublicationWorker | undefined;
  try {
    const connection = await f.connections.create(f.owner, f.input);
    const first = await f.service.prepare(f.owner, {
      id: randomUUID(),
      buildId: f.build.id,
      connectionId: connection.id,
      connectionVersion: 1,
    });
    const second = await f.service.prepare(f.owner, {
      id: randomUUID(),
      buildId: f.build.id,
      connectionId: connection.id,
      connectionVersion: 1,
    });
    expect(f.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_snapshots").get()!.total).toBe(
      1,
    );
    const adapter = new LocalSiteDelivery(f.targets);
    await f.service.publish(f.owner, first.plan.id, first.plan.fingerprint);
    worker = new PublicationWorker(
      f.store,
      () => ({
        reconcile: (plan, artifact) => adapter.reconcile(plan, artifact),
        deliver: async (plan, artifact, gate) => {
          await adapter.deliver(plan, artifact, gate);
          throw new DeliveryError("deliveryFailed");
        },
      }),
      async () => () => {},
      () => {},
    );
    worker.wake();
    await worker.idle();
    await worker.stop();
    expect((await f.service.detail(f.owner, first.plan.id)).job.phase).toBe("needsAttention");
    await expect(f.service.publish(f.owner, second.plan.id, second.plan.fingerprint)).rejects.toThrow("targetBusy");
    expect(f.store.acquire()).toBeNull();
    f.connections.update(f.owner, connection.id, {
      version: 1,
      name: connection.name,
      publicUrl: connection.publicUrl,
      enabled: false,
    });
    expect((await f.service.reconcile(f.owner, first.plan.id)).job.phase).toBe("reconciling");
    worker = new PublicationWorker(
      f.store,
      () => ({
        reconcile: (plan, artifact) => adapter.reconcile(plan, artifact),
        deliver: async () => {
          throw new Error("Read-only reconciliation must never call deliver");
        },
      }),
      (owner, plan, check) => f.service.assertExecutable(owner, plan, check),
      () => {},
    );
    worker.wake();
    await worker.idle();
    expect((await f.service.detail(f.owner, first.plan.id)).job.phase).toBe("published");
    expect(readdirSync(join(f.targetsRoot, "fixture", "releases"))).toEqual([first.plan.id]);
    expect(f.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_snapshots").get()!.total).toBe(
      1,
    );
    await f.service.cancel(f.owner, second.plan.id);
    expect(f.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_snapshots").get()!.total).toBe(
      0,
    );
  } finally {
    await worker?.stop();
    f.dispose();
  }
});

test("unused plans expire while an active publication retains its snapshot", async () => {
  const f = fixture();
  try {
    const connection = await f.connections.create(f.owner, f.input);
    const first = await f.service.prepare(f.owner, {
      id: randomUUID(),
      buildId: f.build.id,
      connectionId: connection.id,
      connectionVersion: 1,
    });
    const second = await f.service.prepare(f.owner, {
      id: randomUUID(),
      buildId: f.build.id,
      connectionId: connection.id,
      connectionVersion: 1,
    });
    await f.service.publish(f.owner, first.plan.id, first.plan.fingerprint);
    const later = new PublicationRepository(f.db, () => Date.now() + 2 * 86400000);
    later.expire();
    expect(later.get(first.plan.id).job.phase).toBe("queued");
    expect(later.get(second.plan.id).job.error).toBe("planExpired");
    expect(later.snapshot(first.plan.id).files).toHaveLength(1);
    await f.service.cancel(f.owner, first.plan.id);
    expect(f.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_snapshots").get()!.total).toBe(
      0,
    );
  } finally {
    f.dispose();
  }
});
