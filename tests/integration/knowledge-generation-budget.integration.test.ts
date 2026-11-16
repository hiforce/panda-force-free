import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { KnowledgeGenerationPolicies } from "../../src/server/knowledge/storage/generation-policies.js";
import { KnowledgeGenerationQueue } from "../../src/server/knowledge/storage/generation-queue.js";
import { KnowledgeGenerationAdmission } from "../../src/server/knowledge/storage/generation-admission.js";
import {
  KnowledgeGenerationBudgetStore,
  configureGenerationBudgets,
} from "../../src/server/knowledge/storage/generation-budget.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import {
  DEFAULT_GENERATION_BUDGET,
  type KnowledgeGenerationBudgetLimits,
} from "../../src/shared/knowledge/generation-budget.js";
import { removeGenerationBudgetSchema, removeGenerationSourceSchema } from "../support/legacy-knowledge-schema.js";
import { auditGenerationBudgets } from "../../src/server/knowledge/storage/generation-budget-audit.js";
import type { Database } from "bun:sqlite";
import type { GenerationLease } from "../../src/server/knowledge/generation/contracts.js";

function components(db: Database) {
  const ledger = knowledgeTaskLedger(db),
    policies = new KnowledgeGenerationPolicies(db, ledger),
    queue = new KnowledgeGenerationQueue(db, ledger),
    admission = new KnowledgeGenerationAdmission(db),
    budget = new KnowledgeGenerationBudgetStore(db),
    now = 1000000;
  return {
    db,
    ledger,
    policies,
    queue,
    admission,
    budget,
    now,
    prepare(owner: string, project: string) {
      const prior = policies.policy(owner, project);
      policies.configure(
        owner,
        project,
        {
          ...defaultGenerationPolicy(),
          revision: prior.revision,
          enabled: true,
          purpose: "Shared generation budgets",
          selection: { ...defaultGenerationPolicy().selection, all: true },
          dailyLimit: 100,
          pendingLimit: 16,
          backfill: true,
        },
        { commit: "commit-" + project, documents: [{ id: "doc-" + project, parentId: null, version: "version-1" }] },
        now,
      );
    },
    create(lease: GenerationLease, legacy = false) {
      return ledger.create(
        {
          owner: lease.owner,
          project: lease.project,
          title: lease.project,
          operationId: lease.operationId,
          requestHash: "a".repeat(64),
          signature: lease.owner + ":" + lease.project,
          inputDigest: "b".repeat(64),
          dialogueDigest: "c".repeat(64),
        },
        now + 2000,
        (id, created, time) => {
          if (!legacy) return admission.admit(lease, id, created, time);
          db.query(
            "INSERT INTO knowledge_generation_usage VALUES(?,?,0,1) ON CONFLICT(owner,project,day) DO UPDATE SET used=used+1",
          ).run(lease.owner, lease.project);
          db.query(
            "INSERT INTO knowledge_generation_origins(taskId,owner,project,documentId,version,policyRevision,createdAt) VALUES(?,?,?,?,?,?,?)",
          ).run(id, lease.owner, lease.project, lease.source.id, lease.source.version, lease.policyRevision, time);
        },
      );
    },
    admit(owner: string, project: string) {
      this.prepare(owner, project);
      const lease = queue.claim(now + 2000)!;
      expect(lease.owner).toBe(owner);
      expect(lease.project).toBe(project);
      try {
        return this.create(lease);
      } catch (error) {
        queue.release(lease, now + 2000, (Math.floor(now / 86400000) + 1) * 86400000, false, true);
        throw error;
      }
    },
  };
}
function fixture(limits: KnowledgeGenerationBudgetLimits) {
  const db = openKnowledgeDatabase(":memory:");
  configureGenerationBudgets(db, limits);
  return components(db);
}
test("per-user and installation daily budgets span projects and policy replacement cannot reset them", () => {
  const f = fixture({ installationDaily: 3, ownerDaily: 2, installationPending: 8, ownerPending: 4 });
  try {
    f.admit("alice", "a1");
    f.admit("alice", "a2");
    expect(() => f.admit("alice", "a3")).toThrow("budget");
    expect(f.db.query("SELECT COUNT(*) n FROM knowledge_tasks").get()).toEqual({ n: 2 });
    expect(f.db.query("SELECT COUNT(*) n FROM knowledge_submissions").get()).toEqual({ n: 2 });
    expect(f.budget.status("alice", "a3", { dailyLimit: 100, pendingLimit: 16 }, f.now)).toMatchObject({
      ownerDailyUsed: 2,
      ownerPending: 2,
      blocked: "ownerDaily",
    });
    f.policies.configure(
      "alice",
      "a1",
      { ...defaultGenerationPolicy(), revision: 1, enabled: false, backfill: false },
      null,
      f.now,
    );
    expect(f.admission.usage("alice", "a1", f.now)).toBe(1);
    f.admit("bob", "b1");
    expect(() => f.admit("bob", "b2")).toThrow("budget");
    expect(f.budget.status("bob", "b2", { dailyLimit: 100, pendingLimit: 16 }, f.now)).toMatchObject({
      ownerDailyUsed: 1,
      blocked: "installationDaily",
    });
    expect(f.admission.retryAt("bob", "b2", 100, f.now)).toBe(86400000);
    expect(f.budget.status("alice", "a1", { dailyLimit: 100, pendingLimit: 16 }, 86400000)).toMatchObject({
      ownerDailyUsed: 0,
      blocked: null,
    });
    expect(f.db.query("SELECT used FROM knowledge_generation_totals WHERE scope='installation'").get()).toEqual({
      used: 3,
    });
  } finally {
    f.db.close();
  }
});
test("unfinished work is bounded across projects and failed-task retries cannot bypass the shared pending guard", () => {
  const f = fixture({ installationDaily: 100, ownerDaily: 50, installationPending: 2, ownerPending: 1 });
  try {
    f.admit("alice", "a1");
    expect(() => f.admit("alice", "a2")).toThrow("budget");
    f.admit("bob", "b1");
    expect(() => f.admit("carol", "c1")).toThrow("budget");
    const running = f.ledger.claim(f.now + 2000, 30000)!;
    expect(f.ledger.fail(running.lease, "unavailable", f.now + 2001)).toBe(true);
    f.admit("carol", "c2");
    expect(() => f.ledger.retry(running.task.owner, running.task.id, f.now + 2002)).toThrow("budget");
    expect(f.ledger.get(running.task.owner, running.task.id).state).toBe("failed");
    const other = f.ledger.list("carol", "c2")[0]!;
    f.ledger.cancel("carol", other.id, f.now + 2003);
    const retried = f.ledger.retry(running.task.owner, running.task.id, f.now + 2004);
    expect(retried.state).toBe("queued");
    expect(retried.origin?.manual).toBe(true);
    expect(f.db.query("SELECT COUNT(*) n FROM knowledge_generation_pending").get()).toEqual({ n: 2 });
    expect(f.db.query("SELECT used FROM knowledge_generation_totals WHERE scope='installation'").get()).toEqual({
      used: 3,
    });
  } finally {
    f.db.close();
  }
});
test.each([
  { installationDaily: 100, ownerDaily: 50, installationPending: 1, ownerPending: 1 },
  { installationDaily: 1, ownerDaily: 1, installationPending: 8, ownerPending: 4 },
])(
  "database guards also roll back legacy writer task, operation and usage when installation capacity is full: %j",
  (limits) => {
    const f = fixture(limits);
    try {
      f.admit("alice", "a1");
      f.prepare("bob", "b1");
      const lease = f.queue.claim(f.now + 2000)!;
      expect(() => f.create(lease, true)).toThrow("knowledge_generation_budget");
      expect(f.db.query("SELECT COUNT(*) n FROM knowledge_tasks").get()).toEqual({ n: 1 });
      expect(f.db.query("SELECT COUNT(*) n FROM knowledge_submissions").get()).toEqual({ n: 1 });
      expect(f.db.query("SELECT used FROM knowledge_generation_totals WHERE scope='installation'").get()).toEqual({
        used: 1,
      });
      expect(f.admission.usage("bob", "b1", f.now)).toBe(0);
    } finally {
      f.db.close();
    }
  },
);
test("quota audits rebuild derived metadata and SQL guards without changing retained usage or active task history", () => {
  const f = fixture({ installationDaily: 100, ownerDaily: 50, installationPending: 8, ownerPending: 4 });
  try {
    f.admit("alice", "a1");
    f.admit("alice", "a2");
    const tasks = f.db.query("SELECT * FROM knowledge_tasks ORDER BY id").all(),
      origins = f.db.query("SELECT * FROM knowledge_generation_origins ORDER BY taskId").all(),
      usage = f.db.query("SELECT * FROM knowledge_generation_usage ORDER BY owner,project,day").all();
    expect(auditGenerationBudgets(f.db)).toEqual({ repaired: false });
    configureGenerationBudgets(f.db, { installationDaily: 1, ownerDaily: 1, installationPending: 1, ownerPending: 1 });
    f.db.exec("DELETE FROM knowledge_generation_totals; DELETE FROM knowledge_generation_pending;");
    f.db.exec("DROP TRIGGER knowledge_generation_usage_update; DROP INDEX knowledge_generation_pending_owner;");
    expect(auditGenerationBudgets(f.db)).toEqual({ repaired: true });
    expect(auditGenerationBudgets(f.db)).toEqual({ repaired: false });
    expect(f.db.query("SELECT * FROM knowledge_tasks ORDER BY id").all()).toEqual(tasks);
    expect(f.db.query("SELECT * FROM knowledge_generation_origins ORDER BY taskId").all()).toEqual(origins);
    expect(f.db.query("SELECT * FROM knowledge_generation_usage ORDER BY owner,project,day").all()).toEqual(usage);
    expect(f.budget.status("alice", "a1", { dailyLimit: 100, pendingLimit: 16 }, f.now)).toMatchObject({
      ownerDailyUsed: 2,
      ownerPending: 2,
      blocked: "ownerDaily",
    });
    expect(() => f.admit("bob", "b1")).toThrow("budget");
    f.db.exec("DROP TRIGGER knowledge_generation_usage_insert;");
    f.db.exec(
      "CREATE TRIGGER knowledge_generation_usage_insert AFTER INSERT ON knowledge_generation_usage BEGIN SELECT 1; END;",
    );
    expect(auditGenerationBudgets(f.db)).toEqual({ repaired: true });
    expect(auditGenerationBudgets(f.db)).toEqual({ repaired: false });
  } finally {
    f.db.close();
  }
});
test("missing administrator limits hold admission and audit until valid administrator configuration restores them", () => {
  const f = fixture(DEFAULT_GENERATION_BUDGET);
  try {
    f.admit("alice", "a1");
    f.db.exec("DELETE FROM knowledge_generation_limits;");
    expect(() => auditGenerationBudgets(f.db)).toThrow("unavailable");
    expect(() => f.admit("bob", "b1")).toThrow("unavailable");
    f.prepare("carol", "c1");
    const lease = f.queue.claim(f.now + 2000)!;
    expect(() => f.create(lease, true)).toThrow("knowledge_generation_budget");
    configureGenerationBudgets(f.db, DEFAULT_GENERATION_BUDGET);
    expect(auditGenerationBudgets(f.db)).toEqual({ repaired: false });
    expect(f.db.query("SELECT COUNT(*) n FROM knowledge_tasks").get()).toEqual({ n: 1 });
    expect(f.admission.usage("alice", "a1", f.now)).toBe(1);
  } finally {
    f.db.close();
  }
});
test("version-four usage and task rows migrate without refunds and independent connections share the same daily ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-generation-budgets-")),
    path = join(root, "knowledge.sqlite");
  let db = openKnowledgeDatabase(path),
    second: Database | null = null;
  try {
    const old = components(db);
    old.admit("alice", "a1");
    old.admit("alice", "a2");
    const rows = db.query("SELECT * FROM knowledge_tasks ORDER BY id").all(),
      origins = db.query("SELECT * FROM knowledge_generation_origins ORDER BY taskId").all();
    removeGenerationSourceSchema(db);
    removeGenerationBudgetSchema(db);
    db.exec("PRAGMA user_version=4");
    db.close();
    db = openKnowledgeDatabase(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(db.query("SELECT * FROM knowledge_tasks ORDER BY id").all()).toEqual(rows);
    expect(db.query("SELECT * FROM knowledge_generation_origins ORDER BY taskId").all()).toEqual(origins);
    expect(db.query("SELECT used FROM knowledge_generation_totals WHERE scope='installation'").get()).toEqual({
      used: 2,
    });
    expect(db.query("SELECT COUNT(*) n FROM knowledge_generation_pending").get()).toEqual({ n: 2 });
    configureGenerationBudgets(db, { ...DEFAULT_GENERATION_BUDGET, installationDaily: 3, ownerDaily: 3 });
    second = openKnowledgeDatabase(path);
    const one = components(db),
      two = components(second);
    one.prepare("bob", "b1");
    two.prepare("carol", "c1");
    const first = one.queue.claim(one.now + 2000)!,
      last = two.queue.claim(two.now + 2000)!;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => one.create(first)),
      Promise.resolve().then(() => two.create(last)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(db.query("SELECT used FROM knowledge_generation_totals WHERE scope='installation'").get()).toEqual({
      used: 3,
    });
    second.close();
    second = null;
    db.close();
    db = openKnowledgeDatabase(path);
    expect(db.query("SELECT used FROM knowledge_generation_totals WHERE scope='installation'").get()).toEqual({
      used: 3,
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    second?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
