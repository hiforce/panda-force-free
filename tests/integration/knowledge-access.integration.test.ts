import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { KnowledgeOutputs } from "../../src/server/knowledge/tasks/outputs.js";
import { KnowledgeAccessAudit } from "../../src/server/knowledge/tasks/access.js";
import { KnowledgeAccessScopes } from "../../src/server/knowledge/storage/access.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { createFileDocumentApplication } from "../../src/server/documents/files/application.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import type { KnowledgeRecord } from "../../src/shared/knowledge/tasks.js";
import { KnowledgeTasks } from "../../src/server/knowledge/tasks/service.js";
import { FileApprovedKnowledgeReader } from "../../src/server/knowledge/integration/approved-reader.js";

test("an approved file read rechecks the current adapter authority before returning its result", async () => {
  const f = await knowledgeCatalogFixture();
  let permitted = true;
  try {
    f.complete();
    const reader = new FileApprovedKnowledgeReader(
      f.catalog,
      async () => {
        if (!permitted) throw new DocumentError("notFound", 404);
        permitted = false;
        return f.documents.application().projectContent;
      },
      () => {},
    );
    await expect(
      reader.current({ owner: f.owner, project: f.input.scope.project }, [f.record.id]),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.close();
  }
}, 30000);

test("permission revoked during an asynchronous knowledge read or retry prevents the response and metadata mutation", async () => {
  const f = await knowledgeCatalogFixture();
  let allowed = true;
  const content = new FileDocumentKnowledgeContent(f.documents.application().projectContent);
  content.authorize = async () => {
    if (!allowed) throw new DocumentError("notFound", 404);
  };
  content.current = async () => {
    allowed = false;
    return true;
  };
  const tasks = new KnowledgeTasks(
    f.ledger,
    f.files,
    content,
    async () => f.input.profile,
    new KnowledgeOutputs(f.ledger, f.files, content),
    { wake() {}, interrupt() {} },
  );
  try {
    await expect(tasks.detail(f.owner, f.admission.taskId)).rejects.toMatchObject({ status: 404 });
    allowed = true;
    f.db.query("UPDATE knowledge_tasks SET state='failed',failure='interrupted' WHERE id=?").run(f.admission.taskId);
    await expect(tasks.retry(f.owner, f.admission.taskId)).rejects.toMatchObject({ status: 404 });
    expect(f.ledger.get(f.owner, f.admission.taskId).state).toBe("failed");
  } finally {
    await f.close();
  }
}, 30000);

test("revocation recovers an exact committed receipt without granting another content read or write", async () => {
  const f = await knowledgeCatalogFixture();
  try {
    const denied = createFileDocumentApplication({
        root: f.documents.root,
        assetRoot: f.documents.assetRoot,
        principal: () => f.owner,
        requireProject() {
          throw new DocumentError("notFound", 404);
        },
        authorizeUnderLease() {
          throw new DocumentError("notFound", 404);
        },
      }),
      content = new FileDocumentKnowledgeContent(denied.projectContent, f.documents.application().projectContent),
      head = await f.documents.snapshots.head();
    await expect(content.capture(f.owner, f.input.scope)).rejects.toMatchObject({ status: 404 });
    await expect(content.save(f.owner, f.input, f.record)).rejects.toMatchObject({ status: 404 });
    await new KnowledgeOutputs(f.ledger, f.files, content).reconcile(f.owner, f.admission.taskId);
    expect(f.ledger.get(f.owner, f.admission.taskId).state).toBe("completed");
    expect(f.catalog.current(f.admission)?.projection).toEqual(f.projection);
    expect(await f.documents.snapshots.head()).toBe(head);
    await expect(content.recover("wrong-owner", f.input, f.record)).rejects.toMatchObject({ code: "conflict" });

    const input = { ...f.input, target: { id: "k-unwritten", expectedVersion: null } },
      task = f.ledger.create(
        {
          owner: f.owner,
          project: f.input.scope.project,
          title: "Unwritten output",
          operationId: randomUUID(),
          requestHash: "u".repeat(64),
          signature: "v".repeat(64),
          inputDigest: await f.files.putInput(input),
          dialogueDigest: await f.files.putDialogue({ questions: [], answers: [] }),
        },
        Date.now(),
      ),
      claim = f.ledger.claim(Date.now(), 30000)!,
      scope = f.ledger.bind(claim.lease, { sessionId: "isolated", runId: "unwritten" }, Date.now()),
      record: KnowledgeRecord = { ...f.record, id: input.target.id, taskId: task.id, version: "" };
    record.version = knowledgeRecordVersion(record);
    f.ledger.draft(
      scope,
      await f.files.putDraft(await f.files.draft(f.ledger.get(f.owner, f.admission.taskId).draftDigest!)),
      Date.now(),
    );
    const digest = await f.files.putOutput(record);
    f.ledger.admit(f.owner, task.id, 1, digest, Date.now());
    await expect(new KnowledgeOutputs(f.ledger, f.files, content).reconcile(f.owner, task.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.ledger.get(f.owner, task.id).state).toBe("cancelled");
    expect(await f.documents.snapshots.head()).toBe(head);
    // A writer that was opened before cancellation must recheck delivery metadata inside its physical file lease.
    await expect(
      f.content.save(f.owner, input, record, () => {
        if (f.ledger.get(f.owner, task.id).state !== "committing") throw new Error("Delivery no longer admitted");
      }),
    ).rejects.toThrow("Delivery no longer admitted");
    expect(await f.documents.snapshots.head()).toBe(head);
  } finally {
    await f.close();
  }
}, 30000);

test("scope audits cancel waiting and manually adopted work, disable policies and preserve completed receipts and usage", async () => {
  const f = await knowledgeCatalogFixture();
  try {
    f.complete();
    const policy = { owner: f.owner, project: f.input.scope.project },
      store = new KnowledgeAccessScopes(f.db),
      interrupted: string[] = [],
      runtime = {
        scopes: () => [],
        interruptScope: (owner: string, project: string) => {
          interrupted.push(owner + ":" + project);
        },
      };
    f.db
      .query(
        "INSERT INTO knowledge_generation_policies(owner,project,revision,enabled,purpose,selection,dailyLimit,pendingLimit,observedCommit,updatedAt) VALUES(?,?,1,1,'Scope','{}',8,4,NULL,1)",
      )
      .run(f.owner, policy.project);
    for (const state of ["queued", "waiting", "review"]) {
      const task = f.ledger.create(
        {
          owner: f.owner,
          project: policy.project,
          title: state,
          operationId: randomUUID(),
          requestHash: state,
          signature: state,
          inputDigest: f.admission.inputDigest,
          dialogueDigest: await f.files.putDialogue({ questions: [], answers: [] }),
        },
        Date.now(),
      );
      f.db
        .query("UPDATE knowledge_tasks SET state=?,draftDigest=? WHERE id=?")
        .run(state, state === "review" ? "d".repeat(64) : null, task.id);
      f.db
        .query(
          "INSERT INTO knowledge_generation_origins(taskId,owner,project,documentId,version,policyRevision,createdAt,manual) VALUES(?,?,?,?,?,?,?,1)",
        )
        .run(task.id, f.owner, policy.project, randomUUID(), "version", 1, Date.now());
    }
    f.db.query("INSERT INTO knowledge_review_policies VALUES(?,?,1,1,1)").run(f.owner, policy.project);
    f.db.query("INSERT INTO knowledge_generation_usage VALUES(?,?,0,3)").run(f.owner, policy.project);
    const before = f.db.query("SELECT * FROM knowledge_generation_usage").all(),
      errors: unknown[] = [],
      unavailable = new KnowledgeAccessAudit(
        store,
        {
          authorize: async () => {
            throw new DocumentError("unavailable", 503);
          },
        },
        runtime,
        (e) => errors.push(e),
      );
    await unavailable.tick();
    expect(f.ledger.list(f.owner, policy.project).filter((t) => t.state === "cancelled")).toHaveLength(0);
    expect(f.db.query("SELECT enabled FROM knowledge_generation_policies").get()).toEqual({ enabled: 1 });
    expect(errors.length).toBeGreaterThan(0);
    await new KnowledgeAccessAudit(
      store,
      {
        authorize: async () => {
          throw new DocumentError("notFound", 404);
        },
      },
      runtime,
      () => {},
    ).tick();
    expect(f.ledger.list(f.owner, policy.project).filter((t) => t.state === "cancelled")).toHaveLength(3);
    expect(f.ledger.get(f.owner, f.admission.taskId).result).toEqual(f.admission.receipt);
    expect(f.db.query("SELECT enabled,revision FROM knowledge_generation_policies").get()).toEqual({
      enabled: 0,
      revision: 2,
    });
    expect(f.db.query("SELECT automatic,revision FROM knowledge_review_policies").get()).toEqual({
      automatic: 0,
      revision: 2,
    });
    expect(f.db.query("SELECT * FROM knowledge_generation_usage").all()).toEqual(before);
    expect(f.db.query("SELECT COUNT(*) n FROM knowledge_generation_pending").get()).toEqual({ n: 0 });
    expect(interrupted).toContain(f.owner + ":" + policy.project);
  } finally {
    await f.close();
  }
}, 30000);

test("a live knowledge engine is aborted after project contribution is revoked", async () => {
  const f = await knowledgeCatalogFixture();
  let allowed = true,
    started = false,
    aborted = false;
  const content: FileDocumentKnowledgeContent = new FileDocumentKnowledgeContent(
    f.documents.application().projectContent,
  );
  content.authorize = async () => {
    if (!allowed) throw new DocumentError("notFound", 404);
  };
  const feature = createKnowledgeFeature({
    stateRoot: join(f.root, "runtime"),
    content,
    profile: async () => f.input.profile,
    available: () => true,
    owner: () => f.owner,
    report: () => {},
    engine: () => ({
      id: "codex",
      async run(_input, callbacks) {
        await callbacks.started({ sessionId: "isolated-access", runId: "held" });
        started = true;
        await new Promise<void>((resolve) => {
          const finish = () => {
            aborted = true;
            resolve();
          };
          callbacks.signal.addEventListener("abort", finish, { once: true });
          if (callbacks.signal.aborted) finish();
        });
        return { sessionId: "isolated-access", runId: "held", status: "interrupted" };
      },
    }),
  });
  try {
    const task = await feature.service.submit(f.owner, {
      id: randomUUID(),
      ...f.input.scope,
      purpose: "Verify revoke",
    });
    feature.start();
    const deadline = Date.now() + 5000;
    while (!started && Date.now() < deadline) await Bun.sleep(10);
    expect(started).toBeTrue();
    allowed = false;
    while (!aborted && Date.now() < deadline) await Bun.sleep(20);
    expect(aborted).toBeTrue();
    allowed = true;
    expect((await feature.service.detail(f.owner, task.id)).task.state).toBe("cancelled");
  } finally {
    await feature.close();
    await f.close();
  }
}, 30000);
