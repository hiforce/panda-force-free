import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PersonalContent } from "../../src/server/creative/personal.js";
import { fileKnowledgeGenerationSource } from "../../src/server/knowledge/integration/generation-content.js";
import { KnowledgeGenerationSettings } from "../../src/server/knowledge/generation/service.js";
import { KnowledgeGenerationPolicies } from "../../src/server/knowledge/storage/generation-policies.js";
import { KnowledgeGenerationQueue } from "../../src/server/knowledge/storage/generation-queue.js";
import { KnowledgeGenerationDiscovery } from "../../src/server/knowledge/generation/discovery.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-empty-generation-")),
    db = openKnowledgeDatabase(":memory:"),
    personal = new PersonalContent({
      contentRoot: join(root, "content"),
      assetRoot: join(root, "assets"),
      stateRoot: join(root, "state"),
      owner: () => "alice",
    });
  let hook = async () => {},
    allowed = true,
    initializations = 0;
  const projects = async (owner: string) => {
      if (!allowed) throw Error("Permission withdrawn");
      return personal.readProjects(owner);
    },
    source = fileKnowledgeGenerationSource(projects, async (owner) => {
      initializations++;
      const writer = await personal.forOwner(owner);
      await writer.documents.projectContent.initialize("personal", async () => {});
      await hook();
    }),
    policies = new KnowledgeGenerationPolicies(db, knowledgeTaskLedger(db)),
    settings = new KnowledgeGenerationSettings(
      policies,
      source,
      { authorize: async (owner, project) => (await projects(owner)).authorize(project) },
      { wake() {}, interrupt() {} },
    );
  return {
    root,
    db,
    personal,
    source,
    policies,
    settings,
    initializations: () => initializations,
    hook: (work: () => Promise<void>) => {
      hook = work;
    },
    revoke: () => {
      allowed = false;
    },
    close: async () => {
      db.close();
      await personal.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const policy = () => ({
  ...defaultGenerationPolicy(),
  enabled: true,
  purpose: "Explain future saved decisions",
  selection: { ...defaultGenerationPolicy().selection, all: true },
  backfill: false,
});
test("an empty scope previews without creating content, then explicit rule application pins an initialized empty Git baseline", async () => {
  const f = await fixture();
  try {
    const preview = await f.settings.preview("alice", "personal", policy());
    expect(preview).toMatchObject({ commit: "empty", count: 0 });
    expect(await readdir(f.root)).toEqual([]);
    expect(f.initializations()).toBe(0);
    await f.settings.configure("alice", "personal", policy(), preview.commit);
    expect(f.initializations()).toBe(1);
    const baseline = await f.source.snapshot("alice", "personal");
    expect(baseline.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.documents).toEqual([]);
    expect(f.policies.policy("alice", "personal").observedCommit).toBe(baseline.commit);
    expect(f.db.query("SELECT * FROM knowledge_tasks").all()).toEqual([]);
    const writer = await f.personal.forOwner("alice"),
      created = await writer.documents.navigation.create("alice", {
        id: randomUUID(),
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        title: "First future source",
        locale: "en",
      });
    const discovery = new KnowledgeGenerationDiscovery(
      f.policies,
      new KnowledgeGenerationQueue(f.db, knowledgeTaskLedger(f.db)),
      f.source,
      { interrupt() {} },
      (error) => {
        throw error;
      },
    );
    await discovery.scan(new AbortController().signal);
    expect(f.db.query("SELECT documentId,state FROM knowledge_generation_jobs").all()).toEqual([
      { documentId: created.operation.documentId, state: "queued" },
    ]);
    await expect(f.settings.configure("alice", "personal", policy(), "empty")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.initializations()).toBe(1);
  } finally {
    await f.close();
  }
}, 30000);
test("a first saved document arriving during empty initialization invalidates the empty preview instead of silently backfilling it", async () => {
  const f = await fixture();
  try {
    const preview = await f.settings.preview("alice", "personal", policy());
    f.hook(async () => {
      const writer = await f.personal.forOwner("alice");
      await writer.documents.navigation.create("alice", {
        id: randomUUID(),
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        title: "Arrived after preview",
        locale: "en",
      });
    });
    await expect(f.settings.configure("alice", "personal", policy(), preview.commit)).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await f.settings.policy("alice", "personal")).revision).toBe(0);
    expect(f.db.query("SELECT * FROM knowledge_tasks").all()).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
test("revoked empty scope and stale policy revisions cannot commit a rule or start model work", async () => {
  const f = await fixture();
  try {
    f.hook(async () => {
      f.revoke();
    });
    await expect(f.settings.configure("alice", "personal", policy(), "empty")).rejects.toThrow("Permission withdrawn");
    expect(f.policies.policy("alice", "personal").revision).toBe(0);
  } finally {
    await f.close();
  }
  const stale = await fixture();
  try {
    await expect(
      stale.settings.configure("alice", "personal", { ...policy(), revision: 1 }, "empty"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(stale.initializations()).toBe(0);
    expect(await readdir(stale.root)).toEqual([]);
  } finally {
    await stale.close();
  }
}, 30000);
