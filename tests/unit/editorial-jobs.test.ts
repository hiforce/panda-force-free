import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createEditorialFeature } from "../../src/server/editorial/integration/feature.js";
import { documentEditorialSources } from "../../src/server/editorial/integration/document-source.js";
import { EditorialJobRepository } from "../../src/server/editorial/jobs/repository.js";
import { EditorialJobs } from "../../src/server/editorial/jobs/service.js";
import { EditorialWorker } from "../../src/server/editorial/jobs/worker.js";
import type { EditorialModel, EditorialModelInput } from "../../src/server/editorial/model/contracts.js";
import { migrateEditorial } from "../../src/server/editorial/schema.js";

const body: RichDocumentBody = {
  schema: 1,
  format: "richtext",
  document: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "This are a test.", marks: [{ type: "bold" }] }] }],
  },
};
const response = (input: EditorialModelInput) =>
  JSON.stringify({
    edits: input.segments.map((segment) => ({
      segmentId: segment.id,
      before: segment.text,
      after: "This is a test.",
      reason: "Agreement",
    })),
  });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-editorial-job-"));
  const open = () =>
    createDocumentFeature({
      stateRoot: root,
      allowedRoots: [root],
      requireProject: (id) => {
        if (id !== "project") throw Error("Forbidden");
      },
    });
  let documents = open(),
    now = 100000,
    calls = 0;
  const original = documents.library.create("project", { title: "Original", locale: "en" });
  const saved = documents.service.saveDocument(original.document.id, {
    revision: 1,
    title: "Original",
    locale: "en",
    body,
  });
  const model: EditorialModel = {
      profile: { id: "review", engine: "isolated-test", model: "test", version: "1" },
      async process(input) {
        calls++;
        return response(input);
      },
    },
    models = new Map([[model.profile.id, model]]);
  const clock = () => now;
  const make = () => {
    const sources = documentEditorialSources(documents.service, documents.persistence),
      editorial = createEditorialFeature(documents.persistence, sources).service,
      repository = new EditorialJobRepository(documents.persistence),
      jobs = new EditorialJobs(repository, sources, models, clock),
      worker = new EditorialWorker(repository, editorial, sources, models, clock);
    return { sources, editorial, repository, jobs, worker };
  };
  let feature = make();
  return {
    saved,
    model,
    models,
    get calls() {
      return calls;
    },
    get documents() {
      return documents;
    },
    get feature() {
      return feature;
    },
    clock,
    submit: (id: string = randomUUID()) =>
      feature.jobs.submit("owner", {
        id,
        documentId: saved.document.id,
        revisionId: saved.revision.id,
        mode: "proofread",
        profileId: "review",
      }),
    advance(ms: number) {
      now += ms;
    },
    reopen() {
      documents.close();
      documents = open();
      feature = make();
    },
    async close() {
      documents.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("model tasks and review receipts survive restart; submission replays never run a coding turn or overwrite an original", async () => {
  const f = await fixture();
  try {
    const job = await f.submit();
    expect(job.state).toBe("queued");
    const stored = f.documents.persistence.query<{ payload: string }, []>("SELECT payload FROM editorial_jobs").get()!;
    expect(stored.payload.length).toBeLessThan(4096);
    expect(stored.payload).not.toContain("This are a test.");
    expect(JSON.parse(stored.payload).source.body).toBeUndefined();
    expect(await f.submit(job.id)).toEqual(job);
    await expect(f.feature.jobs.detail("other", job.id)).rejects.toThrow("notFound");
    await expect(
      f.feature.jobs.submit("owner", {
        id: job.id,
        documentId: job.source.documentId,
        revisionId: job.source.revisionId,
        mode: "rewrite",
        profileId: "review",
      }),
    ).rejects.toThrow("invalidInput");
    f.reopen();
    expect(await f.feature.jobs.detail("owner", job.id)).toEqual(job);
    expect(await f.feature.worker.runOne()).toBe(true);
    const done = await f.feature.jobs.detail("owner", job.id);
    expect(done.state).toBe("succeeded");
    expect(done.attempts).toBe(1);
    expect(f.calls).toBe(1);
    expect(f.documents.service.detail(job.source.documentId)).toEqual(f.saved);
    const review = await f.feature.editorial.detail("owner", done.proposalId!);
    expect(review.stale).toBe(false);
    expect(review.proposal.mode).toBe("proofread");
    expect(review.proposal.edits).toHaveLength(1);
    expect(review.receipt).toBeNull();
    const receipt = await f.feature.editorial.accept("owner", {
      id: done.proposalId,
      digest: review.digest,
      selected: review.proposal.edits.map((edit) => edit.id),
    });
    f.reopen();
    expect(await f.feature.jobs.detail("owner", job.id)).toEqual(done);
    expect((await f.feature.editorial.detail("owner", done.proposalId!)).receipt).toEqual(receipt);
    expect(f.documents.service.detail(job.source.documentId).revision.body!.document.content![0]!.content![0]).toEqual({
      type: "text",
      text: "This is a test.",
      marks: [{ type: "bold" }],
    });
    expect(await f.feature.worker.runOne()).toBe(false);
    expect(await f.submit(job.id)).toEqual(done);
  } finally {
    await f.close();
  }
});

test("cancellation fences late results, explicit retries are idempotent even after another failure, and profiles are immutable", async () => {
  const f = await fixture();
  try {
    let finish!: (value: string) => void, received!: EditorialModelInput, started!: () => void;
    const processing = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.model.process = (input) => {
      received = input;
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const job = await f.submit(),
      running = f.feature.worker.runOne();
    await processing;
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("running");
    expect(await f.feature.worker.runOne()).toBe(false);
    expect((await f.feature.jobs.cancel("owner", job.id)).state).toBe("cancelled");
    finish(response(received));
    await running;
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("cancelled");
    expect(await f.feature.editorial.list("owner", job.source.documentId)).toEqual([]);
    const key = randomUUID();
    expect((await f.feature.jobs.retry("owner", job.id, key)).generation).toBe(1);
    f.model.process = async () => {
      throw Error("private provider authentication data");
    };
    await f.feature.worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).failure).toBe("processingFailed");
    expect(JSON.stringify(await f.feature.jobs.detail("owner", job.id))).not.toContain("authentication");
    expect((await f.feature.jobs.retry("owner", job.id, key)).state).toBe("failed");
    expect(await f.feature.worker.runOne()).toBe(false);
    f.models.set("review", { profile: { ...f.model.profile, version: "2" }, process: f.model.process });
    await expect(f.feature.jobs.retry("owner", job.id, randomUUID())).rejects.toThrow("unavailable");
    expect((await f.submit(job.id)).profile.version).toBe("1");
    expect(f.documents.service.detail(job.source.documentId)).toEqual(f.saved);
  } finally {
    await f.close();
  }
});

test("expired leases recover at most three attempts and old workers cannot commit or fail a successor", async () => {
  const f = await fixture();
  try {
    const job = await f.submit(),
      repo = f.feature.repository;
    const first = repo.claim(f.clock(), 1000)!;
    f.advance(1001);
    const second = repo.claim(f.clock(), 1000)!;
    expect(second.job.attempts).toBe(2);
    expect(second.token).not.toBe(first.token);
    expect(repo.heartbeat(first, f.clock(), 1000)).toBe(false);
    expect(repo.fail(first, f.clock(), "processingFailed")).toBe(false);
    let committed = false;
    expect(() =>
      repo.complete(first, f.clock(), () => {
        committed = true;
        return "forged";
      }),
    ).toThrow("leaseLost");
    expect(committed).toBe(false);
    f.advance(1001);
    f.reopen();
    const third = f.feature.repository.claim(f.clock(), 1000)!;
    expect(third.job.attempts).toBe(3);
    f.advance(1001);
    expect(f.feature.repository.claim(f.clock(), 1000)).toBeNull();
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("failed");
    expect((await f.feature.jobs.detail("owner", job.id)).failure).toBe("interrupted");
    const reset = await f.feature.jobs.retry("owner", job.id, randomUUID());
    expect(reset.state).toBe("queued");
    expect(reset.attempts).toBe(3);
    expect(reset.generation).toBe(1);
    await f.feature.worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("succeeded");
  } finally {
    await f.close();
  }
});

test("a source changed during model processing becomes a stale review, not an overwritten revision", async () => {
  const f = await fixture();
  try {
    let finish!: (value: string) => void, received!: EditorialModelInput, started!: () => void;
    const processing = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.model.process = (input) => {
      received = input;
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const job = await f.submit(),
      running = f.feature.worker.runOne();
    await processing;
    const changed = f.documents.service.saveDocument(job.source.documentId, {
      revision: 2,
      title: "My new title",
      locale: "en",
      body: {
        ...body,
        document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New draft." }] }] },
      },
    });
    finish(response(received));
    await running;
    const done = await f.feature.jobs.detail("owner", job.id),
      review = await f.feature.editorial.detail("owner", done.proposalId!);
    expect(done.state).toBe("succeeded");
    expect(review.stale).toBe(true);
    await expect(
      f.feature.editorial.accept("owner", {
        id: done.proposalId,
        digest: review.digest,
        selected: review.proposal.edits.map((edit) => edit.id),
      }),
    ).rejects.toThrow("staleSource");
    expect(f.documents.service.detail(job.source.documentId)).toEqual(changed);
  } finally {
    await f.close();
  }
});

test("proposal and task completion commit together; invalid output and failed completion leave no partial review", async () => {
  const f = await fixture();
  try {
    const job = await f.submit();
    f.model.process = async () => '{"edits":[],"execute":"publish"}';
    await f.feature.worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).failure).toBe("invalidOutput");
    expect(await f.feature.editorial.list("owner", job.source.documentId)).toEqual([]);
    await f.feature.jobs.retry("owner", job.id, randomUUID());
    f.model.process = async (input) => response(input);
    f.documents.persistence.exec(
      "CREATE TRIGGER reject_editorial_completion BEFORE UPDATE ON editorial_jobs WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'completion fixture failure'); END",
    );
    await f.feature.worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("failed");
    expect(await f.feature.editorial.list("owner", job.source.documentId)).toEqual([]);
    f.documents.persistence.exec("DROP TRIGGER reject_editorial_completion");
    await f.feature.jobs.retry("owner", job.id, randomUUID());
    await f.feature.worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("succeeded");
    expect(await f.feature.editorial.list("owner", job.source.documentId)).toHaveLength(1);
    expect(f.documents.service.detail(job.source.documentId)).toEqual(f.saved);
  } finally {
    await f.close();
  }
});

test("model computation holds no SQLite write lock and revoked source access prevents a provider call", async () => {
  const f = await fixture();
  try {
    f.model.process = async (input) => {
      const other = new Database(f.documents.persistence.filename);
      try {
        other.exec("UPDATE editorial_schema SET version=version");
      } finally {
        other.close();
      }
      return response(input);
    };
    const job = await f.submit();
    await f.feature.worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("succeeded");
    const next = await f.submit();
    let called = false;
    f.model.process = async () => {
      called = true;
      return '{"edits":[]}';
    };
    const worker = new EditorialWorker(
      f.feature.repository,
      f.feature.editorial,
      {
        ...f.feature.sources,
        current() {
          throw Error("No longer accessible");
        },
      },
      f.models,
      f.clock,
    );
    await worker.runOne();
    expect(called).toBe(false);
    expect((await f.feature.jobs.detail("owner", next.id)).state).toBe("failed");
    expect(await f.feature.editorial.list("owner", job.source.documentId)).toHaveLength(1);
    expect(f.documents.service.detail(job.source.documentId)).toEqual(f.saved);
  } finally {
    await f.close();
  }
});

test("shutdown aborts an uncooperative adapter without hanging and model deadlines fail safely", async () => {
  const f = await fixture();
  try {
    f.model.process = () => new Promise(() => {});
    const job = await f.submit(),
      stopping = new AbortController(),
      running = f.feature.worker.runOne(stopping.signal);
    stopping.abort();
    await running;
    expect((await f.feature.jobs.detail("owner", job.id)).state).toBe("queued");
    const worker = new EditorialWorker(
      f.feature.repository,
      f.feature.editorial,
      f.feature.sources,
      f.models,
      f.clock,
      10,
    );
    await worker.runOne();
    expect((await f.feature.jobs.detail("owner", job.id)).failure).toBe("timeout");
  } finally {
    await f.close();
  }
});

test("task capacity limits apply to each owner, the whole instance and explicit retries", async () => {
  const db = new Database(":memory:");
  try {
    const ref = { documentId: "document", revisionId: "revision", sourceHash: "hash", version: 1 };
    const model: EditorialModel = {
      profile: { id: "review", engine: "fixture", model: "test", version: "1" },
      async process() {
        return '{"edits":[]}';
      },
    };
    const jobs = new EditorialJobs(
      new EditorialJobRepository(db),
      {
        authorize: () => () => {},
        applied: () => null,
        current: () => ref,
        revision: () => ({ ref, body }),
        apply: () => {
          throw Error("Not used by submission");
        },
      },
      new Map([["review", model]]),
    );
    const submit = (owner: string) =>
      jobs.submit(owner, {
        id: randomUUID(),
        documentId: ref.documentId,
        revisionId: ref.revisionId,
        mode: "proofread",
        profileId: "review",
      });
    const cancelled = await submit("owner");
    await jobs.cancel("owner", cancelled.id);
    const active = await Promise.all(Array.from({ length: 32 }, () => submit("owner")));
    await expect(submit("owner")).rejects.toThrow("unavailable");
    const retryId = randomUUID();
    await expect(jobs.retry("owner", cancelled.id, retryId)).rejects.toThrow("unavailable");
    await jobs.cancel("owner", active[0]!.id);
    expect((await jobs.retry("owner", cancelled.id, retryId)).state).toBe("queued");
    expect((await jobs.retry("owner", cancelled.id, retryId)).state).toBe("queued");
    for (let owner = 1; owner < 8; owner++) for (let i = 0; i < 32; i++) await submit("owner-" + owner);
    await expect(submit("another-owner")).rejects.toThrow("unavailable");
  } finally {
    db.close();
  }
});

test("editorial schema1 upgrades without modifying existing source versions or review data and refuses newer schemas", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`PRAGMA user_version=6;
      CREATE TABLE editorial_schema (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT INTO editorial_schema VALUES(1,1);
      CREATE TABLE editorial_proposals (id TEXT PRIMARY KEY,documentId TEXT NOT NULL,owner TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX editorial_by_source ON editorial_proposals(owner,documentId,createdAt);
      CREATE TABLE editorial_applications (proposalId TEXT PRIMARY KEY REFERENCES editorial_proposals(id),selection TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
      INSERT INTO editorial_proposals VALUES('previous','doc','owner','request','payload','digest',1);
      INSERT INTO editorial_applications VALUES('previous','selection','receipt','digest');`);
    const proposal = {
      schema: 1,
      id: "previous",
      source: { documentId: "doc", revisionId: "revision", sourceHash: "hash", version: 1 },
      mode: "spacing",
      producer: { kind: "rules", version: "1" },
      edits: [],
      truncated: false,
      createdAt: 1,
    };
    const payload = JSON.stringify(proposal);
    db.query("UPDATE editorial_proposals SET payload=?,digest=?").run(
      payload,
      createHash("sha256").update(payload).digest("hex"),
    );
    const before = db.query("SELECT * FROM editorial_proposals").all(),
      receipts = db.query("SELECT * FROM editorial_applications").all();
    migrateEditorial(db);
    migrateEditorial(db);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(db.query("SELECT version FROM editorial_schema").get()).toEqual({ version: 4 });
    expect(
      db.query("SELECT id,documentId,owner,request,payload,digest,createdAt FROM editorial_proposals").all(),
    ).toEqual(before);
    expect(db.query("SELECT sourceProjectId FROM editorial_proposals").all()).toEqual([{ sourceProjectId: null }]);
    expect(db.query("SELECT * FROM editorial_applications").all()).toEqual(receipts);
    expect(db.query("SELECT COUNT(*) AS count FROM editorial_jobs").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM editorial_history").get()).toEqual({ count: 1 });
    db.exec("UPDATE editorial_schema SET version=5");
    expect(() => migrateEditorial(db)).toThrow("unavailable");
  } finally {
    db.close();
  }
});
