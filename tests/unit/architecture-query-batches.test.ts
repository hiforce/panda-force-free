import { expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { knowledgeReviewStore } from "../../src/server/knowledge/storage/review-store.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { KnowledgeTasks } from "../../src/server/knowledge/tasks/service.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import type { ActiveSearchIndex } from "../../src/server/search/state.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";

test("a history page batches latest reviews, preserves ordering and rechecks authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "architecture-reviews-")),
    db = openKnowledgeDatabase(":memory:"),
    ledger = knowledgeTaskLedger(db),
    reviews = knowledgeReviewStore(db);
  let batches = 0,
    checks = 0,
    revoke = false;
  try {
    const tasks = Array.from({ length: 53 }, (_, i) => {
      const task = ledger.create(
        {
          owner: "alice",
          project: "project",
          title: `Task ${i}`,
          signature: `batch-${i}`,
          operationId: randomUUID(),
          requestHash: "d".repeat(64),
          inputDigest: "a".repeat(64),
          dialogueDigest: "b".repeat(64),
        },
        i,
      );
      ledger.cancel("alice", task.id, i);
      return ledger.get("alice", task.id);
    });
    const seed = (id: string, owner: string, taskId: string, taskRevision: number, policyRevision: number) =>
      db
        .query(
          `INSERT INTO knowledge_reviews(id,owner,project,taskId,taskRevision,policyRevision,
        inputDigest,dialogueDigest,draftDigest,state,token,leaseUntil,createdAt)
        VALUES(?,?,'project',?,?,?,'input','dialogue','draft','passed','token',100,1)`,
        )
        .run(id, owner, taskId, taskRevision, policyRevision);
    seed("old-policy", "alice", tasks[52]!.id, 1, 9);
    seed("new-draft", "alice", tasks[52]!.id, 2, 1);
    seed("new-policy", "alice", tasks[52]!.id, 2, 2);
    seed("foreign-review", "bob", tasks[52]!.id, 99, 99);
    seed("first-task", "alice", tasks[0]!.id, 1, 1);
    expect(reviews.latestFor("alice", [tasks[52]!.id, tasks[52]!.id])[0]?.id).toBe("new-policy");
    expect(reviews.latestFor("nobody", [tasks[52]!.id])).toEqual([]);
    expect(reviews.latestFor("alice", [])).toEqual([]);
    expect(() =>
      reviews.latestFor(
        "alice",
        tasks.map((task) => task.id),
      ),
    ).toThrow("invalidInput");
    const service = new KnowledgeTasks(
      ledger,
      knowledgeTaskFiles(root),
      {
        async authorize(owner, project) {
          expect([owner, project]).toEqual(["alice", "project"]);
          if (++checks % 2 === 0 && revoke) throw Error("revoked");
        },
        async capture() {
          throw Error("History must not capture content");
        },
        async current() {
          return true;
        },
        async save() {
          throw Error("History must not write content");
        },
      },
      async () => ({ id: "fixture", engineId: "codex", model: "fixture", activeTimeoutMs: 180000 }),
      { async reconcile() {} },
      { wake() {}, interrupt() {} },
      Date.now,
      {
        latest() {
          throw Error("Unexpected per-task query");
        },
        latestFor(owner, ids) {
          batches++;
          return reviews.latestFor(owner, ids);
        },
      },
    );
    const first = await service.history("alice", "project");
    expect(batches).toBe(1);
    expect(first.tasks.map((task) => task.id)).toEqual(
      tasks
        .slice(3)
        .reverse()
        .map((task) => task.id),
    );
    expect(first.tasks[0]?.automaticReview?.id).toBe("new-policy");
    expect(first.tasks[0]?.automaticReview?.state).toBe("superseded");
    expect(first.tasks[1]?.automaticReview).toBeNull();
    expect(first.nextCursor).not.toBeNull();
    const next = await service.history("alice", "project", first.nextCursor!);
    expect(batches).toBe(2);
    expect(next.tasks.map((task) => task.id)).toEqual(
      tasks
        .slice(0, 3)
        .reverse()
        .map((task) => task.id),
    );
    expect(next.tasks.at(-1)?.automaticReview?.id).toBe("first-task");
    revoke = true;
    await expect(service.list("alice", "project")).rejects.toThrow("revoked");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("search readiness continues beyond a full page and rejects stale, invalid or review-required indexes", () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    source = new SearchSourceRegistry(db).get("builtin");
  try {
    const active: ActiveSearchIndex = {
      text: { provider: "local", name: "a".repeat(64) },
      vector: null,
      source,
      sourceRevision: 1,
      settingsRevision: 1,
      analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
      embedding: null,
      textFingerprint: "fixture",
    };
    for (let i = 0; i < 70; i++) {
      const scope = { source: "builtin", project: `project-${i}`, owner: "alice" };
      jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
      const row = jobs.get(scope)!;
      db.query("UPDATE search_scopes SET state='ready',active=? WHERE key=?").run(
        JSON.stringify({ ...active, invalidated: true }),
        row.key,
      );
    }
    const last = db.query<{ key: string }, []>("SELECT key FROM search_scopes ORDER BY key DESC LIMIT 1").get()!.key;
    expect(jobs.hasReadyIndex("builtin", 1)).toBeFalse();
    db.query("UPDATE search_scopes SET active=? WHERE key=?").run(JSON.stringify(active), last);
    expect(jobs.hasReadyIndex("builtin", 1)).toBeTrue();
    expect(jobs.hasReadyIndex("other-source", 1)).toBeFalse();
    expect(jobs.hasReadyIndex("builtin", 2)).toBeFalse();
    db.query("UPDATE search_project_policies SET needsReview=1 WHERE key=?").run(last);
    expect(jobs.hasReadyIndex("builtin", 1)).toBeFalse();
    db.query("UPDATE search_project_policies SET needsReview=0,owner='bob' WHERE key=?").run(last);
    expect(jobs.hasReadyIndex("builtin", 1)).toBeFalse();
    expect(jobs.referencesUncertain()).toBeTrue();
    db.query("UPDATE search_project_policies SET owner='alice' WHERE key=?").run(last);
    db.query("UPDATE search_scopes SET active=? WHERE key=?").run("{damaged", last);
    expect(jobs.hasReadyIndex("builtin", 1)).toBeFalse();
    expect(db.query<{ state: string }, [string]>("SELECT state FROM search_scopes WHERE key=?").get(last)?.state).toBe(
      "queued",
    );
  } finally {
    db.close();
  }
});

test("resource recovery selects complete bounded rows and cleanup excludes released reservations", () => {
  const db = new Database(":memory:"),
    jobs = new SiteBuildRepository(db);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      ids.push(id);
      jobs.create(
        {
          id,
          spaceId: "space",
          engine: "hexo",
          title: "Recovery",
          locale: "en",
          url: "https://example.test",
          basePath: "/",
        },
        {
          protocol: 1,
          engine: "hexo",
          preset: "reader",
          site: { title: "Recovery", locale: "en", url: "https://example.test", basePath: "/" },
          documents: [],
          assets: [],
        },
        [],
      );
      db.query("INSERT INTO site_build_resource_inputs(id,owner,reservedBytes) VALUES(?,'alice',100)").run(id);
      if (i < 17) jobs.update(id, { phase: "cancelled" });
    }
    const query = spyOn(db, "query");
    jobs.resources.pending();
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(jobs.resources.pending().map((row) => row.job.id)).toEqual(ids.slice(17));
    expect(jobs.resources.pending()[0]).toEqual({ job: jobs.get(ids[17]!), ready: false, reservedBytes: 100 });
    db.query("UPDATE site_build_resource_inputs SET ready=1 WHERE id=?").run(ids[17]!);
    expect(jobs.resources.pending()[0]?.job.id).toBe(ids[18]!);
    expect(jobs.resources.cleanup().map((row) => row.id)).toEqual(ids.slice(0, 16));
    jobs.resources.released(ids[0]!);
    expect(jobs.resources.cleanup().map((row) => row.id)).toEqual(ids.slice(1, 17));
  } finally {
    db.close();
  }
});
