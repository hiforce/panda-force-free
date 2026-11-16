import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import type { ApplicationRunCallbacks, ApplicationToolEngine } from "../../src/shared/engine/application-tools.js";
import type { KnowledgeContent } from "../../src/server/knowledge/tasks/contracts.js";
import type { KnowledgeRecord, KnowledgeTask } from "../../src/shared/knowledge/tasks.js";

const owner = "owner-a",
  project = "project-1",
  sourceText = "Flush acknowledged writes to stable storage.";
const draft = () => ({
  schema: 1,
  title: "Durable writes",
  summary: "Persist acknowledged writes.",
  claims: [
    {
      id: "c1",
      kind: "source",
      text: "Flush writes to stable storage.",
      evidence: [{ sourceId: "doc-1", version: "rev-1", quote: "stable storage" }],
    },
  ],
  uncertainties: [],
});
const verdict = () => ({
  schema: 1,
  verdict: "approve",
  summary: "The summary and claim follow the selected source.",
  checks: { faithfulness: true, coverage: true, separation: true, clarity: true, contradictions: true },
  claims: [{ id: "c1", supported: true, reason: "The source explicitly asks for stable storage." }],
  issues: [],
});

function call(callbacks: ApplicationRunCallbacks, name: string, arguments_: unknown) {
  return callbacks.call({
    sessionId: "review-session",
    runId: "review-run",
    callId: randomUUID(),
    name,
    arguments: arguments_,
  });
}
async function readAll(callbacks: ApplicationRunCallbacks) {
  for (const [name, id] of [
    ["panda_knowledge_review_source", "doc-1"],
    ["panda_knowledge_review_draft", null],
  ] as const) {
    let start: number | null = 0;
    while (start !== null) {
      const result = await call(callbacks, name, { ...(id ? { id } : {}), start });
      expect(result.success).toBeTrue();
      expect(result.text.length).toBeLessThanOrEqual(30000);
      start = JSON.parse(result.text).next;
    }
  }
}
async function until(read: () => Promise<KnowledgeTask>, ready: (value: KnowledgeTask) => boolean) {
  for (let n = 0; n < 200; n++) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Knowledge workflow did not reach the expected durable state");
}
async function fixture(review?: (callbacks: ApplicationRunCallbacks) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "panda-auto-knowledge-")),
    saves: KnowledgeRecord[] = [];
  let current = true,
    authorized = true,
    reviewRuns = 0;
  const errors: unknown[] = [],
    content: KnowledgeContent = {
      async authorize(who, p) {
        if (!authorized || who !== owner || p !== project) throw new Error("denied");
      },
      async capture() {
        return {
          commit: "commit-1",
          target: { id: "knowledge-1", expectedVersion: null },
          sources: [
            { id: "doc-1", version: "rev-1", kind: "asset", title: "Durability", text: sourceText, sections: [] },
          ],
        };
      },
      async current() {
        return current;
      },
      async save(_owner, _input, record) {
        saves.push(record);
        return { id: record.id, version: record.version, commit: "commit-2" };
      },
    },
    engine: ApplicationToolEngine = {
      id: "codex",
      async run(input, callbacks) {
        await callbacks.started({ sessionId: "review-session", runId: "review-run" });
        if (input.tools.some((tool) => tool.name === "panda_knowledge_draft")) {
          const result = await call(callbacks, "panda_knowledge_draft", draft());
          expect(result.success).toBeTrue();
        } else {
          reviewRuns++;
          expect(input.tools.map((tool) => tool.name)).toEqual([
            "panda_knowledge_review_source",
            "panda_knowledge_review_draft",
            "panda_knowledge_review_decision",
          ]);
          expect(input.instructions).toContain("An exact quote proves provenance");
          if (review) await review(callbacks);
          else {
            await readAll(callbacks);
            expect((await call(callbacks, "panda_knowledge_review_decision", verdict())).success).toBeTrue();
          }
        }
        return { sessionId: "review-session", runId: "review-run", status: "completed" };
      },
    };
  const options = {
    stateRoot: root,
    content,
    profile: async () => ({ id: "default", engineId: "codex", model: "pinned-model", activeTimeoutMs: 180000 }),
    engine: () => engine,
    available: () => true,
    owner: () => owner,
    report: (error: unknown) => errors.push(error),
  };
  let feature = createKnowledgeFeature(options);
  feature.start();
  return {
    root,
    saves,
    errors,
    feature: () => feature,
    reviewRuns: () => reviewRuns,
    submit: () =>
      feature.service.submit(owner, { id: randomUUID(), project, ids: ["doc-1"], purpose: "Explain durability" }),
    status: (id: string) => feature.service.status(owner, id),
    enable: () => feature.reviewSettings.configure(owner, project, { automatic: true, revision: 0 }),
    changeSource: () => {
      current = false;
    },
    revoke: () => {
      authorized = false;
    },
    async restart() {
      await feature.close();
      feature = createKnowledgeFeature(options);
      feature.start();
    },
    async close() {
      await feature.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("knowledge defaults to human review; enabling automatic review runs a separate reviewer and commits its exact approved result", async () => {
  const f = await fixture();
  try {
    expect(await f.feature().reviewSettings.policy(owner, project)).toEqual({ automatic: false, revision: 0 });
    const task = await f.submit();
    await until(
      () => f.status(task.id),
      (task) => task.state === "review",
    );
    expect(f.reviewRuns()).toBe(0);
    expect(f.saves).toHaveLength(0);
    await f.enable();
    const completed = await until(
      () => f.status(task.id),
      (task) => task.state === "completed",
    );
    expect(completed.automaticReview?.state).toBe("passed");
    expect(f.reviewRuns()).toBe(1);
    expect(f.saves).toHaveLength(1);
    const approval = f.saves[0]!.approval;
    expect(approval?.mode).toBe("automatic");
    const detail = await f.feature().reviewSettings.detail(owner, task.id);
    expect(detail.report?.draftDigest).toBeDefined();
    expect(detail.report?.claims[0]?.reason).toContain("stable storage");
    expect(detail.report?.model).toBe("pinned-model");
    await f.feature().reviewSettings.configure(owner, project, { automatic: false, revision: 1 });
    expect((await f.status(task.id)).automaticReview?.state).toBe("passed");
    await f.restart();
    expect((await f.status(task.id)).state).toBe("completed");
    expect(f.saves).toHaveLength(1);
    const db = await readFile(join(f.root, "data", "knowledge.sqlite"));
    expect(db.includes(Buffer.from(sourceText))).toBeFalse();
    expect(db.includes(Buffer.from("The summary and claim follow"))).toBeFalse();
  } finally {
    await f.close();
  }
}, 15000);

test("an automatic reviewer cannot approve without reading the complete source and draft", async () => {
  const f = await fixture(async (callbacks) => {
    expect((await call(callbacks, "panda_knowledge_review_decision", verdict())).success).toBeFalse();
    await readAll(callbacks);
    expect((await call(callbacks, "panda_knowledge_review_decision", verdict())).success).toBeTrue();
  });
  try {
    await f.enable();
    const task = await f.submit();
    await until(
      () => f.status(task.id),
      (task) => task.state === "completed",
    );
    expect(f.saves).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test("unsupported conclusions stay in human review and do not automatically rerun the model", async () => {
  const f = await fixture(async (callbacks) => {
    await readAll(callbacks);
    const rejected = {
      ...verdict(),
      verdict: "needsReview",
      checks: { ...verdict().checks, faithfulness: false },
      claims: [{ id: "c1", supported: false, reason: "A broader conclusion needs confirmation." }],
      issues: ["Needs user clarification."],
    };
    expect((await call(callbacks, "panda_knowledge_review_decision", rejected)).success).toBeTrue();
  });
  try {
    await f.enable();
    const task = await f.submit();
    await until(
      () => f.status(task.id),
      (task) => task.automaticReview?.state === "needsReview",
    );
    expect((await f.status(task.id)).state).toBe("review");
    expect(f.saves).toHaveLength(0);
    await f.restart();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.reviewRuns()).toBe(1);
    const reviewed = await f.status(task.id);
    await f.feature().service.approve(owner, task.id, { revision: reviewed.reviewRevision });
    expect(f.saves[0]?.approval).toEqual({ mode: "manual" });
  } finally {
    await f.close();
  }
}, 15000);

for (const change of ["disable", "edit", "source", "cancel", "permission"] as const)
  test(`late automatic approval is fenced after ${change}`, async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    let admitted: boolean | undefined;
    const f = await fixture(async (callbacks) => {
      await readAll(callbacks);
      entered();
      await gate;
      try {
        admitted = (await call(callbacks, "panda_knowledge_review_decision", verdict())).success;
      } catch {
        admitted = false;
      }
    });
    try {
      await f.enable();
      const task = await f.submit();
      await ready;
      if (change === "disable")
        await f.feature().reviewSettings.configure(owner, project, { automatic: false, revision: 1 });
      if (change === "edit")
        await f.feature().service.edit(owner, task.id, { revision: 1, draft: { ...draft(), title: "Human edit" } });
      if (change === "source") f.changeSource();
      if (change === "cancel") await f.feature().service.cancel(owner, task.id);
      if (change === "permission") f.revoke();
      release();
      for (let n = 0; n < 100 && admitted === undefined; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(admitted).toBeFalse();
      expect(f.saves).toHaveLength(0);
    } finally {
      release();
      await f.close();
    }
  }, 15000);
