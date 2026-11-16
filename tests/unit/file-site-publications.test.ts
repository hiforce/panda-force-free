import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { SiteBuild } from "../../src/shared/builds/jobs.js";
import type { PublicationSources } from "../../src/server/delivery/ports.js";
import { publicationAccess } from "../../src/server/delivery/integration/source-access.js";
import { publicationSources } from "../../src/server/delivery/integration/sources.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { PublicationService } from "../../src/server/delivery/service.js";
import { PublicationWorker } from "../../src/server/delivery/worker.js";
import { LocalSiteDelivery } from "../../src/server/delivery/adapters/local-site.js";
import { ConnectionRepository } from "../../src/server/connections/repository.js";
import { ConnectionRegistry } from "../../src/server/connections/registry.js";
import { ConnectionService } from "../../src/server/connections/service.js";
import { LocalTargets } from "../../src/server/connections/adapters/local-targets.js";
import { localConnector } from "../../src/server/connections/adapters/local-connector.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { digest } from "../../src/server/delivery/digest.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";

async function fixture() {
  const root = createTemporaryDirectory("panda-file-delivery-", { preferMemory: true }),
    targetRoot = join(root, "targets"),
    sourceRoot = join(root, "originals"),
    db = new Database(join(root, "state.sqlite")),
    projectId = randomUUID(),
    spaceId = randomUUID(),
    grants = new Set<string>([projectId]),
    space = { ...projectSpaceFixture(spaceId).space, projectId, sourceRoot };
  mkdirSync(targetRoot);
  mkdirSync(sourceRoot);
  db.exec("PRAGMA foreign_keys=ON");
  const state = { legacyReads: 0, fileReads: 0, captured: 0, transactionDuringRead: false };
  const requireProject = (id: string) => {
    if (!grants.has(id)) throw new DocumentError("notFound", 404);
  };
  const bytes = Buffer.from("<h1>Saved file revision</h1>"),
    artifact = {
      protocol: 1 as const,
      bytes: bytes.length,
      files: [{ path: "index.html", data: bytes.toString("base64"), sha256: digest(bytes) }],
    },
    build: SiteBuild = {
      id: randomUUID(),
      projectId,
      spaceId,
      sourceSnapshot: { projectId, commit: "a".repeat(40), spaceVersion: 1 },
      engine: "hexo",
      inputHash: digest("file-input"),
      site: { title: "Files", url: "https://example.test", basePath: "/", locale: "en" },
      sources: [{ id: "original", path: "guide.md", revisionId: "saved", contentHash: digest("saved body") }],
      phase: "completed",
      image: null,
      preset: "reader",
      error: null,
      connection: "ready",
      outputBytes: bytes.length,
      fileCount: 1,
      artifactAvailable: true,
      createdAt: 100,
      updatedAt: 100,
    };
  const sources = publicationSources(
    {
      async publicationSnapshot() {
        state.captured++;
        return { build, artifact };
      },
    },
    {
      spaces: {
        get() {
          state.legacyReads++;
          throw new DocumentError("notFound", 404);
        },
      },
      listSpaces() {
        state.legacyReads++;
        throw new DocumentError("notFound", 404);
      },
    },
    {
      requireProject,
      spaces: {
        async get(project, id) {
          state.fileReads++;
          state.transactionDuringRead ||= db.inTransaction;
          await Promise.resolve();
          requireProject(project);
          if (id !== spaceId || project !== projectId) throw new DocumentError("notFound", 404);
          return { space, profile: null };
        },
      },
    },
  );
  const targets = new LocalTargets([{ id: "local", path: targetRoot }], () => []),
    connections = new ConnectionService(
      new ConnectionRepository(db),
      new ConnectionRegistry([localConnector(targets)]),
      requireProject,
    ),
    connection = await connections.create("owner", {
      id: randomUUID(),
      projectId,
      name: "Disposable target",
      connector: "local-site",
      root: "local",
      directory: "website",
      publicUrl: "https://example.test/",
    }),
    store = new PublicationRepository(db);
  const createService = (port: PublicationSources = sources) =>
    new PublicationService(port, connections, store, () => {});
  const service = createService();
  const request = () => ({
    id: randomUUID(),
    projectId,
    buildId: build.id,
    connectionId: connection.id,
    connectionVersion: connection.version,
  });
  return {
    root,
    targetRoot,
    sourceRoot,
    db,
    projectId,
    spaceId,
    grants,
    state,
    sources,
    targets,
    connections,
    connection,
    build,
    artifact,
    store,
    service,
    createService,
    request,
    dispose() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("file publication keeps its explicit scope, Git snapshot and frozen bytes across worker restart", async () => {
  const f = await fixture();
  let worker: PublicationWorker | undefined;
  try {
    const request = f.request(),
      prepared = await f.service.prepare("owner", request);
    expect(prepared.plan.sourceProjectId).toBe(f.projectId);
    expect(prepared.plan.build.sourceSnapshot).toEqual(f.build.sourceSnapshot);
    expect(readdirSync(f.targetRoot)).toEqual([]);
    expect(await f.service.prepare("owner", request)).toEqual(prepared);
    expect(await f.service.list("owner", f.spaceId, f.projectId)).toEqual([prepared]);
    await expect(f.service.list("owner", f.spaceId)).rejects.toThrow("notFound");
    await expect(f.service.list("owner", f.spaceId, randomUUID())).rejects.toThrow("notFound");
    const recorded = f.state.legacyReads;
    await expect(f.service.prepare("owner", { ...f.request(), projectId: undefined })).rejects.toThrow("notFound");
    await expect(f.service.prepare("owner", { ...f.request(), projectId: randomUUID() })).rejects.toThrow("notFound");
    expect(f.state.legacyReads).toBe(recorded);
    await f.service.publish("owner", request.id, prepared.plan.fingerprint);
    f.artifact.files[0]!.data = Buffer.from("Unrelated newer output").toString("base64");
    const reopened = new PublicationRepository(f.db);
    worker = new PublicationWorker(
      reopened,
      () => new LocalSiteDelivery(f.targets),
      (owner, plan, check) => f.service.assertExecutable(owner, plan, check),
      () => {},
    );
    worker.wake();
    await worker.idle();
    const result = await f.service.detail("owner", request.id);
    expect(result.job.phase).toBe("published");
    expect(result.plan).toEqual(prepared.plan);
    expect(readFileSync(join(f.targetRoot, "website/current/index.html"), "utf8")).toBe("<h1>Saved file revision</h1>");
    f.connections.update("owner", f.connection.id, {
      version: 1,
      enabled: false,
      name: "Disabled after publication",
      publicUrl: f.connection.publicUrl,
    });
    expect((await f.service.publish("owner", request.id, prepared.plan.fingerprint)).job.receipt).toEqual(
      result.job.receipt,
    );
    expect(f.state.transactionDuringRead).toBe(false);
  } finally {
    await worker?.stop();
    f.dispose();
  }
});

test("async source access cannot outlive a revoked project, and scoped failures never touch legacy sources", async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare("owner", f.request()),
      captured = f.state.captured;
    f.grants.clear();
    await expect(f.service.detail("owner", prepared.plan.id)).rejects.toThrow("notFound");
    await expect(f.service.publish("owner", prepared.plan.id, prepared.plan.fingerprint)).rejects.toThrow("notFound");
    await expect(f.service.cancel("owner", prepared.plan.id)).rejects.toThrow("notFound");
    await expect(f.service.prepare("owner", { ...f.request(), id: prepared.plan.id })).rejects.toThrow("notFound");
    expect(f.state.captured).toBe(captured);
    expect(f.state.legacyReads).toBe(0);
    expect(f.store.get(prepared.plan.id).job.phase).toBe("prepared");
    expect(readdirSync(f.targetRoot)).toEqual([]);
  } finally {
    f.dispose();
  }
});

test("local and remote effect fences recheck the captured authority after asynchronous source authorization", async () => {
  for (const remote of [false, true]) {
    const f = await fixture();
    let worker: PublicationWorker | undefined,
      effects = 0;
    try {
      const prepared = await f.service.prepare("owner", f.request());
      await f.service.publish("owner", prepared.plan.id, prepared.plan.fingerprint);
      worker = new PublicationWorker(
        f.store,
        () => ({
          reconcile: async () => null,
          async deliver(_plan, _artifact, gate) {
            f.grants.clear();
            if (remote)
              await gate.remote("staging", "must-not-send", async () => {
                effects++;
              });
            else
              gate.run("staging", () => {
                effects++;
              });
            throw new Error("Revoked authority should reject the effect");
          },
        }),
        (owner, plan, check) => f.service.assertExecutable(owner, plan, check),
        () => {},
      );
      worker.wake();
      await worker.idle();
      expect(effects).toBe(0);
      expect(f.store.get(prepared.plan.id).job.phase).toBe("failed");
      expect(f.db.query<{ count: number }, []>("SELECT count(*) AS count FROM publication_effects").get()!.count).toBe(
        0,
      );
      expect(f.state.transactionDuringRead).toBe(false);
    } finally {
      await worker?.stop();
      f.dispose();
    }
  }
});

test("file source reads fail before queueing and source directories cannot become local publication targets", async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare("owner", f.request());
    const failing = f.createService({
      ...f.sources,
      async authorize() {
        throw new DocumentError("unavailable", 503);
      },
    });
    await expect(failing.publish("owner", prepared.plan.id, prepared.plan.fingerprint)).rejects.toThrow("unavailable");
    expect(f.store.get(prepared.plan.id).job.phase).toBe("prepared");
    const access = await f.sources.authorize(f.spaceId, f.projectId);
    expect(() => access.assertDestination(f.sourceRoot)).toThrow("protectedPath");
    expect(() => access.assertDestination(join(f.sourceRoot, "generated"))).toThrow("protectedPath");
    expect(() => access.assertDestination(f.root)).toThrow("protectedPath");
    expect(() => access.assertDestination(join(f.targetRoot, "website"))).not.toThrow();
    expect(f.state.legacyReads).toBe(0);
  } finally {
    f.dispose();
  }
});

test("the publication ledger separates identical space identifiers by persisted source scope and owner", async () => {
  const f = await fixture();
  try {
    const first = await f.service.prepare("owner", f.request()),
      secondProject = randomUUID(),
      secondRequest = { ...f.request(), projectId: secondProject },
      secondPlan = {
        ...first.plan,
        ...secondRequest,
        projectId: secondProject,
        sourceProjectId: secondProject,
        build: {
          ...first.plan.build,
          sourceSnapshot: { ...first.plan.build.sourceSnapshot!, projectId: secondProject },
        },
      };
    const second = f.store.prepare("owner", secondRequest, secondPlan, f.artifact);
    const legacyRequest = {
      id: randomUUID(),
      buildId: f.build.id,
      connectionId: f.connection.id,
      connectionVersion: 1,
    };
    const { sourceProjectId: _sourceProjectId, ...unscoped } = first.plan;
    const legacy = f.store.prepare("owner", legacyRequest, { ...unscoped, id: legacyRequest.id }, f.artifact);
    expect(f.store.list("owner", f.spaceId, f.projectId)).toEqual([first]);
    expect(f.store.list("owner", f.spaceId, secondProject)).toEqual([second]);
    expect(f.store.list("owner", f.spaceId)).toEqual([legacy]);
    expect(f.store.list("other", f.spaceId, f.projectId)).toEqual([]);
  } finally {
    f.dispose();
  }
});

test("source protection resolves missing children through aliases and treats filesystem roots as ancestors", async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, "source-alias");
    symlinkSync(f.sourceRoot, alias);
    const guarded = publicationAccess(() => {}, [join(alias, "not-created")]);
    expect(() => guarded.assertDestination(join(f.sourceRoot, "not-created/site"))).toThrow("protectedPath");
    expect(() => guarded.assertDestination(join(f.sourceRoot, "not-created-elsewhere"))).not.toThrow();
    expect(() => publicationAccess(() => {}, ["/"]).assertDestination(f.targetRoot)).toThrow("protectedPath");
  } finally {
    f.dispose();
  }
});

test("a project revoked between asynchronous authorization and the queue transaction leaves no queued job", async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare("owner", f.request()),
      fences: boolean[] = [];
    const service = f.createService({
      ...f.sources,
      async authorize(space, project) {
        const access = await f.sources.authorize(space, project);
        return {
          ...access,
          assertCurrent() {
            fences.push(f.db.inTransaction);
            access.assertCurrent();
            if (!f.db.inTransaction) queueMicrotask(() => f.grants.clear());
          },
        };
      },
    });
    await expect(service.publish("owner", prepared.plan.id, prepared.plan.fingerprint)).rejects.toThrow("notFound");
    expect(fences).toEqual([false, true]);
    expect(f.store.get(prepared.plan.id).job.phase).toBe("prepared");
    expect(readdirSync(f.targetRoot)).toEqual([]);
  } finally {
    f.dispose();
  }
});
