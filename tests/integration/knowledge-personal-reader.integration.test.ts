import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalContent } from "../../src/server/creative/personal.js";
import { fileKnowledgeGenerationSource } from "../../src/server/knowledge/integration/generation-content.js";
import { KnowledgeGenerationSettings } from "../../src/server/knowledge/generation/service.js";
import { KnowledgeGenerationPolicies } from "../../src/server/knowledge/storage/generation-policies.js";
import { KnowledgeGenerationStatusStore } from "../../src/server/knowledge/storage/generation-status.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";

test("personal search reads stay absent-safe and never open editing or creation services", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-personal-search-"));
  let starts = 0,
    allowed = true;
  const personal = new PersonalContent({
      contentRoot: join(root, "content"),
      assetRoot: join(root, "assets"),
      stateRoot: join(root, "state"),
      owner: () => "alice",
      creation: () => ({
        routes: [],
        start: () => {
          starts++;
        },
        close: async () => {},
      }),
    }),
    source = documentSearchSource({
      project: personal.readQueries("unused"),
      personal: async (owner) => {
        if (!allowed) throw new Error("revoked");
        return personal.readQueries(owner);
      },
      authorizeProject: async () => {
        throw new Error("Unexpected project read");
      },
    }),
    scope = { source: "builtin", owner: "alice", project: "personal", contentKinds: ["document"] as const };
  try {
    await source.authorize(scope);
    expect(await source.head(scope)).toBe("empty");
    expect(await source.snapshot(scope)).toEqual({ commit: "empty", documents: [] });
    expect(await source.current(scope, [randomUUID()])).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect(starts).toBe(0);
    for (const owner of ["alice", "bob"]) {
      const writer = await personal.forOwner(owner);
      await writer.documents.navigation.create(owner, {
        id: randomUUID(),
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        title: owner + " searchable original",
        locale: "en",
      });
    }
    expect(starts).toBe(2);
    const alice = await source.snapshot(scope),
      bob = await source.snapshot({ ...scope, owner: "bob" });
    expect(alice.documents.map((d) => d.title)).toEqual(["alice searchable original"]);
    expect(bob.documents.map((d) => d.title)).toEqual(["bob searchable original"]);
    expect(await source.current(scope, [bob.documents[0]!.id])).toEqual([]);
    expect((await source.current(scope, [alice.documents[0]!.id]))[0]!.version).toBe(alice.documents[0]!.version);
    expect(starts).toBe(2);
    allowed = false;
    await expect(source.head(scope)).rejects.toThrow("revoked");
    await expect(source.current(scope, [alice.documents[0]!.id])).rejects.toThrow("revoked");
  } finally {
    await personal.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
test("personal approved reads create no directories or creation workers and see a later saved document", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-personal-reader-"));
  let starts = 0;
  const personal = new PersonalContent({
      contentRoot: join(root, "content"),
      assetRoot: join(root, "assets"),
      stateRoot: join(root, "state"),
      owner: () => "alice",
      creation: () => ({
        routes: [],
        start: () => {
          starts++;
        },
        close: async () => {},
      }),
    }),
    projects = personal.readProjects("alice");
  try {
    expect(await projects.ifPresent("personal", async () => true)).toBeNull();
    expect(await readdir(root)).toEqual([]);
    expect(starts).toBe(0);
    await expect(projects.authorize("another-project")).rejects.toMatchObject({ code: "notFound" });
    const writer = await personal.forOwner("alice");
    expect(starts).toBe(1);
    await writer.documents.navigation.create("alice", {
      id: randomUUID(),
      projectId: "personal",
      treeVersion: 0,
      parentId: null,
      title: "Saved later",
      locale: "en",
    });
    expect(await projects.ifPresent("personal", async () => true)).toBeTrue();
    expect(starts).toBe(1);
  } finally {
    await personal.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
test("personal read roots reject a symlink to another identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-personal-reader-link-")),
    content = join(root, "content"),
    parent = join(content, "personal"),
    other = join(root, "another-owner");
  await mkdir(parent, { recursive: true });
  await mkdir(other);
  await symlink(other, join(parent, createHash("sha256").update("alice").digest("hex")));
  const personal = new PersonalContent({
    contentRoot: content,
    assetRoot: join(root, "assets"),
    stateRoot: join(root, "state"),
    owner: () => "alice",
  });
  try {
    await expect(personal.readProjects("alice").ifPresent("personal", async () => true)).rejects.toMatchObject({
      code: "unavailable",
    });
  } finally {
    await personal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("personal rule pages and preview baselines stay private to their owner without initializing empty content", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-personal-rules-")),
    db = openKnowledgeDatabase(":memory:"),
    personal = new PersonalContent({
      contentRoot: join(root, "content"),
      assetRoot: join(root, "assets"),
      stateRoot: join(root, "state"),
      owner: () => "alice",
      creation: () => ({ routes: [], start() {}, close: async () => {} }),
    }),
    source = fileKnowledgeGenerationSource(async (owner) => personal.readProjects(owner)),
    policies = new KnowledgeGenerationPolicies(db, knowledgeTaskLedger(db)),
    settings = new KnowledgeGenerationSettings(
      policies,
      source,
      { authorize: async (owner, project) => personal.readProjects(owner).authorize(project) },
      { interrupt() {}, wake() {} },
      Date.now,
      { catalog: source, status: new KnowledgeGenerationStatusStore(db) },
    );
  try {
    expect(await settings.sources("alice", "personal", 0)).toMatchObject({ commit: "empty", total: 0, documents: [] });
    expect((await settings.policy("alice", "personal")).enabled).toBe(false);
    expect(await readdir(root)).toEqual([]);
    for (const owner of ["alice", "bob"]) {
      const writer = await personal.forOwner(owner);
      await writer.documents.navigation.create(owner, {
        id: randomUUID(),
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        title: owner + " private source",
        locale: "en",
      });
    }
    const alice = await settings.sources("alice", "personal", 0),
      bob = await settings.sources("bob", "personal", 0);
    expect(alice.documents.map((d) => d.title)).toEqual(["alice private source"]);
    expect(bob.documents.map((d) => d.title)).toEqual(["bob private source"]);
    expect(alice.documents[0]!.id).not.toBe(bob.documents[0]!.id);
    const policy = {
        ...defaultGenerationPolicy(),
        enabled: true,
        purpose: "Explain my private decisions",
        selection: { ...defaultGenerationPolicy().selection, all: true },
        backfill: false,
      },
      preview = await settings.preview("alice", "personal", policy);
    expect(preview.count).toBe(1);
    await expect(settings.configure("bob", "personal", policy, preview.commit)).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await settings.configure("alice", "personal", policy, preview.commit)).revision).toBe(1);
    expect((await settings.policy("bob", "personal")).revision).toBe(0);
    expect(await settings.status("alice", "personal")).toMatchObject({
      enabled: true,
      counts: { observed: 1 },
      pendingTasks: 0,
      dailyUsed: 0,
    });
    expect(await settings.status("bob", "personal")).toMatchObject({
      enabled: false,
      counts: { observed: 0 },
      pendingTasks: 0,
      dailyUsed: 0,
    });
  } finally {
    db.close();
    await personal.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
