import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApplicationToolEngine, ApplicationRunCallbacks } from "../../src/shared/engine/application-tools.js";
import type { KnowledgeContent } from "../../src/server/knowledge/tasks/contracts.js";
import { KnowledgeWriteConflict } from "../../src/server/knowledge/tasks/contracts.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { KnowledgeOutputs } from "../../src/server/knowledge/tasks/outputs.js";
import { KnowledgeTasks } from "../../src/server/knowledge/tasks/service.js";
import { KnowledgeWorker } from "../../src/server/knowledge/tasks/worker.js";

const owner = "owner-1",
  selection = { project: "p1", ids: ["doc-1"] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-knowledge-workflow-")),
    path = join(root, "ledger.sqlite"),
    files = knowledgeTaskFiles(root);
  let db = openKnowledgeDatabase(path),
    ledger = knowledgeTaskLedger(db),
    saved = 0,
    current = true,
    sourceText = "Flush writes to stable storage.",
    crashAfterSave = false,
    writeConflict: "sourceChanged" | "targetChanged" | null = null;
  const receipts = new Map<string, { id: string; version: string; commit: string }>(),
    content: KnowledgeContent = {
      async authorize(who, project) {
        if (who !== owner || project !== "p1") throw Error("notFound");
      },
      async capture() {
        return {
          commit: "commit-1",
          target: { id: "k1", expectedVersion: null },
          sources: [
            {
              id: "doc-1",
              version: "rev-1",
              kind: "asset",
              title: "Durability",
              text: sourceText,
              sections: [],
            },
          ],
        };
      },
      async current() {
        return current;
      },
      async save(_who, _input, record) {
        if (writeConflict) throw new KnowledgeWriteConflict(writeConflict);
        let receipt = receipts.get(record.taskId);
        if (!receipt) {
          saved++;
          receipt = { id: record.id, version: record.version, commit: "commit-2" };
          receipts.set(record.taskId, receipt);
        }
        if (crashAfterSave) {
          crashAfterSave = false;
          throw Error("Process stopped after Git committed");
        }
        return receipt;
      },
    };
  const outputs = () => new KnowledgeOutputs(ledger, files, content),
    tasks = () =>
      new KnowledgeTasks(
        ledger,
        files,
        content,
        async () => ({ id: "default", engineId: "codex", model: "pinned-model", activeTimeoutMs: 180000 }),
        outputs(),
        { wake() {}, interrupt() {} },
      ),
    submit = () => tasks().submit(owner, { id: randomUUID(), ...selection, purpose: "Explain storage" });
  const run = async (perform: (callbacks: ApplicationRunCallbacks, prompt: string) => Promise<void>) => {
    const claim = ledger.claim(Date.now(), 30000)!;
    const engine: ApplicationToolEngine = {
      id: "codex",
      async run(input, callbacks) {
        await callbacks.started({ sessionId: "isolated-session", runId: "owned-turn" });
        await perform(callbacks, input.prompt);
        return { sessionId: "isolated-session", runId: "owned-turn", status: "completed" };
      },
    };
    await new KnowledgeWorker(
      ledger,
      files,
      content,
      (profile) => {
        expect(profile.model).toBe("pinned-model");
        return engine;
      },
      () => {},
    ).run(claim, new AbortController().signal);
  };
  return {
    files,
    ledger: () => ledger,
    tasks,
    outputs,
    submit,
    run,
    saved: () => saved,
    changeSource() {
      current = false;
    },
    sourceText(text: string) {
      sourceText = text;
    },
    crashAfterSave() {
      crashAfterSave = true;
    },
    conflictBeforeWrite(reason: "sourceChanged" | "targetChanged") {
      writeConflict = reason;
    },
    restart() {
      db.close();
      db = openKnowledgeDatabase(path);
      ledger = knowledgeTaskLedger(db);
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function call(callbacks: ApplicationRunCallbacks, name: string, arguments_: unknown) {
  return callbacks.call({
    sessionId: "isolated-session",
    runId: "owned-turn",
    callId: randomUUID(),
    name,
    arguments: arguments_,
  });
}
const draft = () => ({
  schema: 1,
  title: "Storage knowledge",
  summary: "Preserve acknowledged writes.",
  claims: [
    {
      id: "c1",
      kind: "source",
      text: "Use stable storage.",
      evidence: [{ sourceId: "doc-1", version: "rev-1", quote: "stable storage" }],
    },
  ],
  uncertainties: [],
});

test("native engine questions enter the durable task channel and release this execution", async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    await f.run(async (callbacks) => {
      await callbacks.question!({ sessionId: "isolated-session", runId: "owned-turn" }, [
        { id: "native-q", question: "Who is the audience?", options: [{ label: "Developers" }, { label: "Readers" }] },
      ]);
    });
    const detail = await f.tasks().detail(owner, task.id);
    expect(detail.task.state).toBe("waiting");
    expect(detail.dialogue.questions[0]!.question).toBe("Who is the audience?");
    expect(f.ledger().get(owner, task.id).token).toBeNull();
  } finally {
    await f.close();
  }
});

test("escaped context chunks stay within the native tool frame and reconstruct the exact saved text", async () => {
  const f = await fixture();
  try {
    const original = '"\\\u0001😀'.repeat(6000) + " stable storage";
    f.sourceText(original);
    await f.submit();
    await f.run(async (callbacks) => {
      const chunks: string[] = [];
      let start: number | null = 0;
      while (start !== null) {
        const result = await call(callbacks, "panda_knowledge_context", { id: "doc-1", start });
        expect(result.success).toBeTrue();
        expect(result.text.length).toBeLessThanOrEqual(30000);
        const value = JSON.parse(result.text);
        chunks.push(value.text);
        start = value.next;
      }
      expect(chunks.join("")).toBe(original);
    });
  } finally {
    await f.close();
  }
});

test("a reviewed draft recovers the same output after a crash between Git commit and metadata completion", async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    await f.run(async (callbacks) => {
      const context = await call(callbacks, "panda_knowledge_context", { id: "doc-1", start: 0 });
      expect(context.success).toBeTrue();
      expect(JSON.parse(context.text).text).toContain("stable storage");
      expect((await call(callbacks, "panda_knowledge_draft", draft())).success).toBeTrue();
    });
    const detail = await f.tasks().detail(owner, task.id);
    expect(detail.task.state).toBe("review");
    expect(detail.draft!.claims[0]!.evidence[0]!.kind).toBe("asset");
    f.crashAfterSave();
    await expect(f.tasks().approve(owner, task.id, { revision: detail.task.reviewRevision })).rejects.toThrow();
    expect(f.ledger().get(owner, task.id).state).toBe("committing");
    f.restart();
    f.changeSource();
    await f.tasks().retry(owner, task.id);
    await f.outputs().reconcile(owner, task.id);
    expect(f.ledger().get(owner, task.id).state).toBe("completed");
    expect(f.saved()).toBe(1);
    expect((await f.tasks().approve(owner, task.id, { revision: detail.task.reviewRevision })).state).toBe("completed");
    expect(f.saved()).toBe(1);
    await expect(f.tasks().detail("foreign-owner", task.id)).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
});

test("a question survives restart and its literal answer becomes separately typed evidence in the next run", async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    await f.run(async (callbacks) => {
      expect(
        (
          await call(callbacks, "panda_knowledge_ask", {
            questions: [{ question: "Which storage?", options: ["Local", "Network"] }],
          })
        ).success,
      ).toBeTrue();
    });
    expect(f.ledger().get(owner, task.id).token).toBeNull();
    f.restart();
    const waiting = await f.tasks().detail(owner, task.id);
    expect(waiting.task.state).toBe("waiting");
    await f.tasks().answer(owner, task.id, {
      answers: [{ questionId: waiting.dialogue.questions[0]!.id, answer: "Use local NVMe." }],
    });
    await f.run(async (callbacks, prompt) => {
      const input = JSON.parse(prompt),
        user = input.sources.find((source: { kind: string }) => source.kind === "user-input");
      expect(user).toBeDefined();
      const proposal = draft();
      proposal.claims.push({
        id: "c2",
        kind: "user",
        text: "The user selected local storage.",
        evidence: [{ sourceId: user.id, version: user.version, quote: "local NVMe" }],
      });
      expect((await call(callbacks, "panda_knowledge_draft", proposal)).success).toBeTrue();
    });
    const review = await f.tasks().detail(owner, task.id);
    expect(review.task.state).toBe("review");
    expect(review.draft!.claims[1]!.evidence[0]!.kind).toBe("user-input");
  } finally {
    await f.close();
  }
});

test("a source change fences model output and prevents saving stale knowledge", async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    await f.run(async (callbacks) => {
      f.changeSource();
      await expect(call(callbacks, "panda_knowledge_draft", draft())).rejects.toThrow("sourceChanged");
    });
    expect(f.ledger().get(owner, task.id).state).toBe("stale");
    await expect(f.tasks().approve(owner, task.id, { revision: 0 })).rejects.toThrow("conflict");
    expect(f.saved()).toBe(0);
  } finally {
    await f.close();
  }
});

test("a fabricated quote is rejected and a corrected model draft can still enter review", async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    await f.run(async (callbacks) => {
      const invalid = draft();
      invalid.claims[0]!.evidence[0]!.quote = "Unsupported fabricated quote";
      expect((await call(callbacks, "panda_knowledge_draft", invalid)).success).toBeFalse();
      expect((await call(callbacks, "panda_knowledge_draft", draft())).success).toBeTrue();
    });
    expect(f.ledger().get(owner, task.id).state).toBe("review");
    expect(f.saved()).toBe(0);
  } finally {
    await f.close();
  }
});

for (const reason of ["sourceChanged", "targetChanged"] as const)
  test(`a ${reason} conflict before the Git write ends stale without delivery retries`, async () => {
    const f = await fixture();
    try {
      const task = await f.submit();
      await f.run(async (callbacks) => {
        await call(callbacks, "panda_knowledge_draft", draft());
      });
      f.conflictBeforeWrite(reason);
      await expect(f.tasks().approve(owner, task.id, { revision: 1 })).rejects.toThrow("conflict");
      const row = f.ledger().get(owner, task.id);
      expect(row.state).toBe("stale");
      expect(row.failure).toBe(reason);
      expect(row.outputAttempts).toBe(0);
      expect(f.ledger().nextOutput()).toBeNull();
      expect(f.saved()).toBe(0);
    } finally {
      await f.close();
    }
  });
