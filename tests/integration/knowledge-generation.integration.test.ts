import { expect, test } from "bun:test";
import { removeGenerationBudgetSchema } from "../support/legacy-knowledge-schema.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { KnowledgeTasks } from "../../src/server/knowledge/tasks/service.js";
import { KnowledgeGenerationPolicies } from "../../src/server/knowledge/storage/generation-policies.js";
import { KnowledgeGenerationQueue } from "../../src/server/knowledge/storage/generation-queue.js";
import { KnowledgeGenerationAdmission } from "../../src/server/knowledge/storage/generation-admission.js";
import { KnowledgeGenerationSettings } from "../../src/server/knowledge/generation/service.js";
import { KnowledgeGenerationWorker } from "../../src/server/knowledge/generation/worker.js";
import { KnowledgeGenerationDiscovery } from "../../src/server/knowledge/generation/discovery.js";
import { KnowledgeGenerationSubmission } from "../../src/server/knowledge/generation/submission.js";
import type { GenerationSnapshot, KnowledgeGenerationSource } from "../../src/server/knowledge/generation/contracts.js";
import type { KnowledgeContent } from "../../src/server/knowledge/tasks/contracts.js";
import { KnowledgeTaskError } from "../../src/server/knowledge/tasks/contracts.js";
import { knowledgeReviewStore } from "../../src/server/knowledge/storage/review-store.js";
import { KnowledgeGenerationStatusStore } from "../../src/server/knowledge/storage/generation-status.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-generation-")),
    path = join(root, "ledger.sqlite"),
    files = knowledgeTaskFiles(join(root, "tasks")),
    errors: unknown[] = [],
    interrupts: string[] = [];
  let db = openKnowledgeDatabase(path),
    time = 1000000,
    captures = 0,
    profiles = 0,
    captureHook = async () => {},
    sourceFence = () => {},
    snapshot: GenerationSnapshot = {
      commit: "commit-1",
      documents: [
        { id: "a", parentId: null, version: "file-1" },
        { id: "b", parentId: "a", version: "file-2" },
        { id: "c", parentId: "b", version: "file-3" },
        { id: "d", parentId: null, version: "file-4" },
      ],
    };
  const content: KnowledgeContent = {
      async authorize(owner, project) {
        if (!["alice", "bob"].includes(owner) || project !== "p1") throw Error("forbidden");
      },
      async capture(_owner, selection) {
        captures++;
        await captureHook();
        const selected = snapshot.documents.filter((d) => selection.ids.includes(d.id));
        return {
          commit: snapshot.commit,
          target: { id: "knowledge-" + selection.ids.join("-"), expectedVersion: null },
          identities: selected.map((d) => ({ id: d.id, version: d.version })),
          sources: selected.map((d) => ({
            id: d.id,
            version: "revision-" + d.version,
            kind: "asset" as const,
            title: "Document " + d.id,
            text: "Saved text " + d.version,
            sections: [],
          })),
        };
      },
      async current() {
        return true;
      },
      async save() {
        throw Error("No model or publication belongs to rule discovery");
      },
    },
    source: KnowledgeGenerationSource = {
      async head() {
        return snapshot.commit;
      },
      async snapshot() {
        return structuredClone(snapshot);
      },
      async withSnapshot(_owner, _project, work) {
        return work(structuredClone(snapshot), sourceFence);
      },
    },
    execution = {
      wake() {},
      interrupt(_owner: string, id: string) {
        interrupts.push(id);
      },
    },
    now = () => time;
  function components(connection = db) {
    const ledger = knowledgeTaskLedger(connection),
      policies = new KnowledgeGenerationPolicies(connection, ledger),
      queue = new KnowledgeGenerationQueue(connection, ledger),
      admission = new KnowledgeGenerationAdmission(connection),
      tasks = new KnowledgeTasks(
        ledger,
        files,
        content,
        async () => {
          profiles++;
          return { id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 1000 };
        },
        { async reconcile() {} },
        execution,
        now,
      ),
      discovery = new KnowledgeGenerationDiscovery(policies, queue, source, execution, (e) => errors.push(e), now),
      submission = new KnowledgeGenerationSubmission(policies, queue, admission, source, tasks, () => true, now),
      worker = new KnowledgeGenerationWorker(
        discovery,
        submission,
        () => true,
        (e) => errors.push(e),
      ),
      settings = new KnowledgeGenerationSettings(policies, source, content, execution, now);
    return { ledger, policies, queue, admission, tasks, worker, settings };
  }
  let c = components();
  return {
    get c() {
      return c;
    },
    get db() {
      return db;
    },
    files,
    errors,
    interrupts,
    captures: () => captures,
    profiles: () => profiles,
    now,
    advance(ms = 6000) {
      time += ms;
    },
    snapshot: () => structuredClone(snapshot),
    change(id: string, version: string) {
      snapshot.documents.find((d) => d.id === id)!.version = version;
      snapshot.commit = randomUUID();
    },
    move(id: string, parentId: string | null) {
      snapshot.documents.find((d) => d.id === id)!.parentId = parentId;
      snapshot.commit = randomUUID();
    },
    async configure(extra: Record<string, unknown> = {}, owner = "alice") {
      const prior = await c.settings.policy(owner, "p1");
      return c.settings.configure(owner, "p1", {
        ...prior,
        enabled: true,
        purpose: "Explain saved engineering decisions",
        selection: { ...defaultGenerationPolicy().selection, all: true },
        backfill: false,
        ...extra,
      });
    },
    hook(work: () => Promise<void>) {
      captureHook = work;
    },
    fence(work: () => void) {
      sourceFence = work;
    },
    async restart() {
      await c.worker.close();
      db.close();
      db = openKnowledgeDatabase(path);
      c = components();
    },
    parallel() {
      const connection = openKnowledgeDatabase(path),
        other = components(connection);
      return {
        ...other,
        async close() {
          await other.worker.close();
          connection.close();
        },
      };
    },
    async close() {
      await c.worker.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("generation is opt-in; preview is metadata-only and enabling without backfill establishes an exact baseline", async () => {
  const f = await fixture();
  try {
    expect((await f.c.settings.policy("alice", "p1")).enabled).toBe(false);
    await f.c.worker.tick();
    const policy = {
      ...defaultGenerationPolicy(),
      enabled: true,
      purpose: "Engineering decisions",
      backfill: false,
      selection: { ...defaultGenerationPolicy().selection, subtrees: ["a"], excludeSubtrees: ["b"] },
    };
    expect(await f.c.settings.preview("alice", "p1", policy)).toMatchObject({ count: 1, documents: ["a"] });
    await f.c.settings.configure("alice", "p1", policy);
    f.advance();
    await f.c.worker.tick();
    expect(f.captures()).toBe(0);
    expect(f.profiles()).toBe(0);
    expect(await f.c.tasks.list("alice", "p1")).toEqual([]);
    expect((await f.c.settings.policy("bob", "p1")).enabled).toBe(false);
  } finally {
    await f.close();
  }
});

test("saved versions coalesce into one exact task and remain idempotent across application restart", async () => {
  const f = await fixture();
  try {
    await f.configure();
    f.change("a", "file-next");
    f.advance();
    await f.c.worker.tick();
    expect(f.captures()).toBe(0);
    f.change("a", "file-final");
    f.advance();
    await f.c.worker.tick();
    f.advance(1501);
    await f.c.worker.tick();
    const tasks = await f.c.tasks.list("alice", "p1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.origin).toEqual({
      kind: "rule",
      documentId: "a",
      version: "file-final",
      policyRevision: 1,
      manual: false,
    });
    expect(new KnowledgeGenerationStatusStore(f.db).status("alice", "p1", f.now())).toMatchObject({
      enabled: true,
      policyRevision: 1,
      dailyUsed: 1,
      pendingTasks: 1,
      counts: { admitted: 1 },
      sourceUnavailable: false,
    });
    expect(new KnowledgeGenerationStatusStore(f.db).status("bob", "p1", f.now())).toMatchObject({
      enabled: false,
      policyRevision: 0,
      dailyUsed: 0,
      pendingTasks: 0,
    });
    expect(f.captures()).toBe(1);
    expect((await f.c.tasks.detail("alice", tasks[0]!.id)).sources[0]!.version).toBe("revision-file-final");
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    await f.restart();
    f.advance();
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    expect(f.c.admission.usage("bob", "p1", f.now())).toBe(0);
  } finally {
    await f.close();
  }
});

test("disabling during source capture fences the task, quota and all late admissions", async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await f.configure({ backfill: true });
    f.advance();
    f.hook(async () => {
      reached();
      await hold;
    });
    const work = f.c.worker.tick();
    await entered;
    await f.configure({ enabled: false });
    release();
    await work;
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(0);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(0);
    expect(f.db.query("SELECT 1 FROM knowledge_submissions").get()).toBeNull();
  } finally {
    release();
    await f.close();
  }
});

test("a newer body cannot be bound to a previous metadata version or operation", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true });
    f.advance();
    const lease = f.c.queue.claim(f.now())!;
    f.change(lease.source.id, "changed-after-discovery");
    await expect(
      f.c.tasks.submit(
        lease.owner,
        { id: lease.operationId, project: lease.project, ids: [lease.source.id], purpose: lease.purpose },
        {
          source: { id: lease.source.id, version: lease.source.version },
          async withSource(_commit, create) {
            return create(() => {});
          },
          commit: (id, created, now) => f.c.admission.admit(lease, id, created, now),
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(0);
    expect(f.db.query("SELECT 1 FROM knowledge_tasks").get()).toBeNull();
    f.c.queue.reconcile(f.c.policies.policy("alice", "p1"), f.snapshot(), f.now());
    const current = f.db
      .query<{ operationId: string }, [string]>("SELECT operationId FROM knowledge_generation_jobs WHERE documentId=?")
      .get(lease.source.id)!;
    expect(current.operationId).not.toBe(lease.operationId);
    expect(() => f.c.admission.admit(lease, "missing", true, f.now())).toThrow("leaseLost");
  } finally {
    await f.close();
  }
});

test("daily admission rollback leaves no extra task or submission and cannot be reset by policy replacement", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true, dailyLimit: 1 });
    f.advance();
    await f.c.worker.tick();
    f.advance();
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM knowledge_submissions").get()!.n).toBe(1);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    await f.configure({ backfill: true, dailyLimit: 1 });
    f.advance();
    await f.c.worker.tick();
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    await f.restart();
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
  } finally {
    await f.close();
  }
});

test("turning rules off cancels their executions while preserving manual work and review policy", async () => {
  const f = await fixture();
  try {
    const reviews = knowledgeReviewStore(f.db);
    reviews.configure("alice", "p1", true, 0, f.now());
    await f.configure({ backfill: true });
    f.advance();
    await f.c.worker.tick();
    const generated = (await f.c.tasks.list("alice", "p1"))[0]!;
    const autoClaim = f.c.ledger.claim(f.now(), 30000)!;
    const execution = f.c.ledger.bind(autoClaim.lease, { sessionId: "isolated", runId: "run" }, f.now());
    const manual = await f.c.tasks.submit("alice", {
      id: randomUUID(),
      project: "p1",
      ids: ["d"],
      purpose: "Manual request",
    });
    await f.configure({ enabled: false });
    expect((await f.c.tasks.status("alice", generated.id)).state).toBe("cancelled");
    expect((await f.c.tasks.status("alice", manual.id)).state).not.toBe("cancelled");
    expect(() => f.c.ledger.assertExecution(execution, f.now())).toThrow("leaseLost");
    expect(reviews.policy("alice", "p1").automatic).toBe(true);
    expect(f.interrupts).toContain(generated.id);
    expect(f.interrupts).not.toContain(manual.id);
  } finally {
    await f.close();
  }
});

test("replaced and expired queue leases cannot release or consume another admission", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true, selection: { ...defaultGenerationPolicy().selection, documents: ["a"] } });
    f.advance();
    const old = f.c.queue.claim(f.now())!;
    f.advance(30001);
    const current = f.c.queue.claim(f.now())!;
    expect(current.source.id).toBe(old.source.id);
    expect(current.token).not.toBe(old.token);
    f.c.queue.release(old, f.now(), f.now());
    expect(() => f.c.queue.heartbeat(current, f.now())).not.toThrow();
    expect(() => f.c.admission.admit(old, "missing", true, f.now())).toThrow("leaseLost");
  } finally {
    await f.close();
  }
});

test("a late automatic reviewer is fenced when its generation rule is disabled", async () => {
  const f = await fixture();
  try {
    const reviews = knowledgeReviewStore(f.db);
    reviews.configure("alice", "p1", true, 0, f.now());
    await f.configure({ backfill: true });
    f.advance();
    await f.c.worker.tick();
    const claim = f.c.ledger.claim(f.now(), 30000)!,
      execution = f.c.ledger.bind(claim.lease, { sessionId: "isolated", runId: "run" }, f.now());
    f.c.ledger.draft(execution, "a".repeat(64), f.now());
    const review = reviews.claim(f.now())!.review;
    await f.configure({ enabled: false });
    expect(() => reviews.assert(review, f.now())).toThrow("leaseLost");
    expect(reviews.latest("alice", claim.task.id)!.state).toBe("superseded");
    expect((await f.c.tasks.status("alice", claim.task.id)).state).toBe("cancelled");
  } finally {
    await f.close();
  }
});

test("generation limits pending tasks without consuming another daily admission", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true, pendingLimit: 1 });
    f.advance();
    await f.c.worker.tick();
    f.advance();
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    const first = (await f.c.tasks.list("alice", "p1"))[0]!;
    await f.c.tasks.cancel("alice", first.id);
    f.advance(15001);
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(2);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(2);
  } finally {
    await f.close();
  }
});

test("generation deduplication never takes ownership of an existing manual task", async () => {
  const f = await fixture();
  try {
    const manual = await f.c.tasks.submit("alice", {
      id: randomUUID(),
      project: "p1",
      ids: ["a"],
      purpose: "Explain saved engineering decisions",
    });
    await f.configure({ backfill: true });
    f.advance();
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(0);
    await f.configure({ enabled: false });
    expect((await f.c.tasks.status("alice", manual.id)).state).toBe("queued");
    expect(f.interrupts).not.toContain(manual.id);
  } finally {
    await f.close();
  }
});

test("generation cancellation preserves a previously admitted file/Git save", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true });
    f.advance();
    await f.c.worker.tick();
    const claim = f.c.ledger.claim(f.now(), 30000)!,
      execution = f.c.ledger.bind(claim.lease, { sessionId: "isolated", runId: "run" }, f.now());
    f.c.ledger.draft(execution, "a".repeat(64), f.now());
    f.c.ledger.admit("alice", claim.task.id, 1, "b".repeat(64), f.now());
    await f.configure({ enabled: false });
    expect((await f.c.tasks.status("alice", claim.task.id)).state).toBe("committing");
    expect(f.interrupts).not.toContain(claim.task.id);
  } finally {
    await f.close();
  }
});

test("a version-three ledger migrates additively with every original task and operation unchanged", async () => {
  const f = await fixture();
  try {
    const task = await f.c.tasks.submit("alice", { id: randomUUID(), project: "p1", ids: ["a"], purpose: "Manual" }),
      before = f.c.ledger.get("alice", task.id),
      submissions = f.db.query("SELECT * FROM knowledge_submissions").all();
    removeGenerationBudgetSchema(f.db);
    f.db.exec(`DROP TABLE knowledge_generation_origins; DROP TABLE knowledge_generation_jobs;
      DROP TABLE knowledge_generation_usage; DROP TABLE knowledge_generation_policies; PRAGMA user_version=3;`);
    await f.restart();
    expect(f.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(f.c.ledger.get("alice", task.id)).toEqual(before);
    expect(f.db.query("SELECT * FROM knowledge_submissions").all()).toEqual(submissions);
    expect((await f.c.settings.policy("alice", "p1")).enabled).toBe(false);
    expect(f.db.query("SELECT 1 FROM knowledge_generation_jobs").get()).toBeNull();
  } finally {
    await f.close();
  }
});

test("moving a document out of its selected subtree during capture cannot admit old queued work", async () => {
  const f = await fixture();
  try {
    await f.configure({
      backfill: true,
      selection: { ...defaultGenerationPolicy().selection, subtrees: ["a"], excludeDocuments: ["a"] },
    });
    f.advance();
    f.hook(async () => {
      f.move("b", null);
    });
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(0);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(0);
    f.advance();
    await f.c.worker.tick();
    expect(f.db.query("SELECT 1 FROM knowledge_generation_jobs").get()).toBeNull();
  } finally {
    await f.close();
  }
});

test("independent database connections recover one expired submission without duplicate tasks or quota", async () => {
  const f = await fixture(),
    second = f.parallel();
  try {
    await f.configure({ backfill: true, selection: { ...defaultGenerationPolicy().selection, documents: ["a"] } });
    f.advance();
    const old = f.c.queue.claim(f.now())!;
    expect(second.queue.claim(f.now())).toBeNull();
    f.advance(30001);
    await second.worker.tick();
    expect(await second.tasks.list("alice", "p1")).toHaveLength(1);
    await expect(
      f.c.tasks.submit(
        old.owner,
        { id: old.operationId, project: old.project, ids: [old.source.id], purpose: old.purpose },
        {
          source: { id: old.source.id, version: old.source.version },
          async withSource(_commit, create) {
            return create(() => {});
          },
          commit: (id, created, now) => f.c.admission.admit(old, id, created, now),
        },
      ),
    ).rejects.toMatchObject({ code: "leaseLost" });
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    expect(second.admission.usage("alice", "p1", f.now())).toBe(1);
  } finally {
    await second.close();
    await f.close();
  }
});

test("an explicit manual request adopts a matching automatic task before rules are disabled", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true });
    f.advance();
    await f.c.worker.tick();
    const automatic = (await f.c.tasks.list("alice", "p1"))[0]!,
      manual = await f.c.tasks.submit("alice", {
        id: randomUUID(),
        project: "p1",
        ids: ["a"],
        purpose: "Explain saved engineering decisions",
      });
    expect(manual.id).toBe(automatic.id);
    expect(automatic.origin?.manual).toBe(false);
    expect(manual.origin?.manual).toBe(true);
    await f.configure({ enabled: false });
    expect((await f.c.tasks.status("alice", manual.id)).state).toBe("queued");
    expect(f.interrupts).not.toContain(manual.id);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
  } finally {
    await f.close();
  }
});

for (const action of ["answer", "edit"] as const)
  test(`a user's ${action} adopts generated work atomically and survives disabling rules after restart`, async () => {
    const f = await fixture();
    try {
      await f.configure({ backfill: true });
      f.advance();
      await f.c.worker.tick();
      const task = (await f.c.tasks.list("alice", "p1"))[0]!,
        claimed = f.c.ledger.claim(f.now(), 30000)!,
        execution = f.c.ledger.bind(claimed.lease, { sessionId: "isolated", runId: "test" }, f.now()),
        input = await f.files.input(claimed.task.inputDigest),
        source = input.sources[0]!,
        draft = {
          schema: 1 as const,
          title: "Reviewed draft",
          summary: "User guidance applies.",
          claims: [
            {
              id: "fact",
              kind: "source" as const,
              text: source.text,
              evidence: [{ sourceId: source.id, version: source.version, quote: source.text }],
            },
          ],
          uncertainties: [],
        };
      expect(claimed.task.id).toBe(task.id);
      if (action === "answer") {
        const dialogue = await f.files.putDialogue({
          questions: [{ id: "q1", question: "Which audience?", options: [] }],
          answers: [],
        });
        f.c.ledger.question(execution, dialogue, f.now());
        await f.c.tasks.answer("alice", task.id, { answers: [{ questionId: "q1", answer: "Maintainers" }] });
      } else {
        f.c.ledger.draft(execution, await f.files.putDraft(draft), f.now());
        await f.c.tasks.edit("alice", task.id, { revision: 1, draft });
      }
      await f.restart();
      await f.configure({ enabled: false });
      expect((await f.c.tasks.status("alice", task.id)).state).toBe(action === "answer" ? "queued" : "review");
      expect(
        f.db
          .query<{ manual: number }, [string]>("SELECT manual FROM knowledge_generation_origins WHERE taskId=?")
          .get(task.id)?.manual,
      ).toBe(1);
      expect(f.interrupts).not.toContain(task.id);
      expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
    } finally {
      await f.close();
    }
  });

test("a saturated scope pauses as a whole while another owner's queued knowledge can proceed", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true, dailyLimit: 1 });
    await f.configure({ backfill: true }, "bob");
    f.advance();
    await f.c.worker.tick();
    await f.c.worker.tick();
    expect(await f.c.tasks.list("alice", "p1")).toHaveLength(1);
    expect(await f.c.tasks.list("bob", "p1")).toHaveLength(1);
    f.advance();
    await f.c.worker.tick();
    const scope = f.db
      .query<{ nextAdmissionAt: number }, []>(
        "SELECT nextAdmissionAt FROM knowledge_generation_policies WHERE owner='alice'",
      )
      .get()!;
    expect(scope.nextAdmissionAt).toBe((Math.floor(f.now() / 86400000) + 1) * 86400000);
    await f.c.worker.tick();
    expect(await f.c.tasks.list("bob", "p1")).toHaveLength(2);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(1);
  } finally {
    await f.close();
  }
});

test("a failed source scan blocks queued admission until an authorized metadata check recovers", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true });
    f.advance();
    const policy = f.c.policies.policy("alice", "p1");
    f.c.policies.checked(policy, f.now(), true);
    f.advance(6000);
    expect(f.c.queue.claim(f.now())).toBeNull();
    expect(f.captures()).toBe(0);
    f.c.policies.checked(policy, f.now(), false);
    expect(f.c.queue.claim(f.now())).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("losing the source read lease before task commit rolls back quota, task, operation and job link", async () => {
  const f = await fixture();
  try {
    await f.configure({ backfill: true });
    f.advance();
    let assertions = 0;
    f.fence(() => {
      if (++assertions === 2) throw new KnowledgeTaskError("leaseLost");
    });
    await f.c.worker.tick();
    expect(assertions).toBe(2);
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(0);
    expect(f.db.query("SELECT 1 FROM knowledge_tasks").get()).toBeNull();
    expect(f.db.query("SELECT 1 FROM knowledge_submissions").get()).toBeNull();
    expect(f.db.query("SELECT 1 FROM knowledge_generation_origins").get()).toBeNull();
    expect(f.db.query("SELECT 1 FROM knowledge_generation_jobs WHERE taskId IS NOT NULL").get()).toBeNull();
  } finally {
    await f.close();
  }
});

test("a stale discovery checkpoint cannot replace a newer desired version from another database connection", async () => {
  const f = await fixture(),
    second = f.parallel();
  try {
    await f.configure();
    const original = f.c.policies.policy("alice", "p1");
    f.change("a", "newer");
    const earlier = f.snapshot();
    f.c.queue.reconcile(original, earlier, f.now());
    const next = second.policies.policy("alice", "p1");
    f.change("a", "newest");
    const latest = f.snapshot();
    second.queue.reconcile(next, latest, f.now());
    expect(() => f.c.queue.reconcile(original, earlier, f.now())).toThrow("conflict");
    f.c.policies.checked(original, f.now(), true);
    expect(f.c.policies.policy("alice", "p1").observedCommit).toBe(latest.commit);
    expect(
      f.db
        .query<{ version: string; scanFailures: number }, []>(
          `SELECT j.version,p.scanFailures FROM knowledge_generation_jobs j
      JOIN knowledge_generation_policies p ON p.owner=j.owner AND p.project=j.project WHERE j.documentId='a'`,
        )
        .get(),
    ).toEqual({ version: "newest", scanFailures: 0 });
  } finally {
    await second.close();
    await f.close();
  }
});

test("overlapping scheduler requests serialize and shutdown drains uncertain source capture before database closure", async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await f.configure({ backfill: true });
    f.advance();
    f.hook(async () => {
      reached();
      await hold;
    });
    const first = f.c.worker.tick();
    await entered;
    const second = f.c.worker.tick();
    expect(second).toBe(first);
    const stopped = f.c.worker.close();
    release();
    await Promise.all([first, second, stopped]);
    expect(f.captures()).toBe(1);
    expect(f.db.query("SELECT 1 FROM knowledge_tasks").get()).toBeNull();
    expect(f.c.admission.usage("alice", "p1", f.now())).toBe(0);
  } finally {
    release();
    await f.close();
  }
});
