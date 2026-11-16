import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { CreationQueue } from "../../src/server/creation/storage/queue.js";
import { CreationQuestionRepository } from "../../src/server/creation/storage/questions.js";
import { FileCreationQuestions } from "../../src/server/creation/integration/question-files.js";
import { CreationQuestions } from "../../src/server/creation/questions/service.js";

const owner = "operator:test-user",
  questions = [
    {
      id: "audience",
      question: "Who will read this private draft?",
      options: [{ label: "Developers" }, { label: "Designers" }],
    },
  ];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-creation-questions-")),
    path = join(root, "tasks.sqlite");
  let now = 10000,
    db = openCreationDatabase(path),
    tasks = new CreationTaskRepository(db),
    queue = new CreationQueue(db, tasks),
    repository = new CreationQuestionRepository(db, tasks),
    service = new CreationQuestions(
      repository,
      new FileCreationQuestions(root),
      async (actor, project) => {
        expect(actor).toBe(owner);
        expect(project).toBe("project-1");
      },
      () => now,
    );
  const spec = {
    schema: 1,
    id: randomUUID(),
    owner,
    projectId: "project-1",
    operationId: randomUUID(),
    kind: "document",
    target: { parentId: null, treeVersion: 0, locale: "en" },
    inputDigest: "a".repeat(64),
    skillCaptureId: null,
  };
  tasks.create(spec, now);
  const claim = queue.claim(now)!,
    scope = tasks.bind(claim.lease, "session", "run", now);
  return {
    spec,
    scope,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    db: () => db,
    tasks: () => tasks,
    queue: () => queue,
    service: () => service,
    repository: () => repository,
    restart() {
      db.close();
      db = openCreationDatabase(path);
      tasks = new CreationTaskRepository(db);
      queue = new CreationQueue(db, tasks);
      repository = new CreationQuestionRepository(db, tasks);
      service = new CreationQuestions(
        repository,
        new FileCreationQuestions(root),
        async () => {},
        () => now,
      );
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Question was not registered");
    await Bun.sleep(5);
  }
}

test("an unanswered creation question survives detach and restart; its answer resumes the same task with a fresh execution generation", async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    const waiting = f
      .service()
      .ask(f.scope, questions, controller.signal)
      .catch((error: Error) => error);
    await until(() => f.repository().pending(owner, f.spec.id) !== null);
    const pending = await f.service().pending(owner, f.spec.id);
    expect(pending!.questions).toEqual(questions);
    f.db().query("UPDATE creation_tasks SET budget=0 WHERE id=?").run(f.spec.id);
    expect(JSON.stringify(f.db().query("SELECT * FROM creation_questions").get())).not.toContain("private draft");
    expect(f.queue().release(f.scope, f.now())).toBe(true);
    controller.abort(new Error("Application stopping"));
    await waiting;
    f.restart();
    expect((await f.service().pending(owner, f.spec.id))!.id).toBe(pending!.id);
    expect(f.queue().claim(f.now())).toBeNull();
    const result = await f.service().answer(owner, pending!.id, { answers: { audience: { answers: ["Developers"] } } });
    expect(result.state).toBe("answered");
    const resumed = f.queue().claim(f.now())!;
    await f.service().answer(owner, pending!.id, { answers: { audience: { answers: ["Developers"] } } });
    expect(
      f.db().query<{ budget: number }, [string]>("SELECT budget FROM creation_tasks WHERE id=?").get(f.spec.id)!.budget,
    ).toBe(0);
    expect(resumed.task.spec.id).toBe(f.spec.id);
    expect(resumed.lease.generation).toBe(f.scope.generation + 1);
    expect((await f.service().history(owner, f.spec.id))[0]!.answers.audience!.answers).toEqual(["Developers"]);
    expect(f.queue().release(f.scope, f.now())).toBe(false);
    await expect(f.service().ask(f.scope, questions, controller.signal)).rejects.toThrow();
  } finally {
    controller.abort();
    await f.close();
  }
});

test("cancelled questionnaires disappear and reject late answers; invalid options never consume a pending question", async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    const waiting = f
      .service()
      .ask(f.scope, questions, controller.signal)
      .catch((error: Error) => error);
    await until(() => f.repository().pending(owner, f.spec.id) !== null);
    const pending = (await f.service().pending(owner, f.spec.id))!;
    await expect(
      f.service().answer(owner, pending.id, { answers: { audience: { answers: ["Unknown option"] } } }),
    ).rejects.toThrow("displayed");
    expect((await f.service().pending(owner, f.spec.id))!.id).toBe(pending.id);
    await expect(
      f.service().answer("operator:foreign", pending.id, { answers: { audience: { answers: ["Developers"] } } }),
    ).rejects.toThrow("notFound");
    f.tasks().cancel(owner, f.spec.id, f.now());
    expect(await f.service().pending(owner, f.spec.id)).toBeNull();
    await expect(
      f.service().answer(owner, pending.id, { answers: { audience: { answers: ["Developers"] } } }),
    ).rejects.toThrow("conflict");
    controller.abort(new Error("Cancelled"));
    await waiting;
    f.restart();
    expect(await f.service().pending(owner, f.spec.id)).toBeNull();
  } finally {
    controller.abort();
    await f.close();
  }
});

test("durable duplicate answers are idempotent and prototype-shaped question IDs remain ordinary answer data", async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    const values = [{ id: "__proto__", question: "Provide an ordinary text answer", isOther: true }],
      waiting = f
        .service()
        .ask(f.scope, values, controller.signal)
        .catch((error: Error) => error);
    await until(() => f.repository().pending(owner, f.spec.id) !== null);
    const pending = (await f.service().pending(owner, f.spec.id))!,
      answer = { answers: Object.fromEntries([["__proto__", { answers: ["Safe text"] }]]) };
    const first = await f.service().answer(owner, pending.id, answer),
      second = await f.service().answer(owner, pending.id, answer);
    expect(first.answerDigest).toBe(second.answerDigest);
    expect(await waiting).toEqual(answer.answers);
    expect(await f.service().pending(owner, f.spec.id)).toBeNull();
    await expect(
      f.service().answer(owner, pending.id, { answers: Object.fromEntries([["__proto__", { answers: ["Changed"] }]]) }),
    ).rejects.toThrow("conflict");
    expect(Object.prototype).not.toHaveProperty("answers");
  } finally {
    controller.abort();
    await f.close();
  }
});

test("pending questions block tool admission, expired claims cannot cancel their successor, and old retry receipts cannot resurrect a cancelled task", async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    const waiting = f
      .service()
      .ask(f.scope, questions, controller.signal)
      .catch((error: Error) => error);
    await until(() => f.repository().pending(owner, f.spec.id) !== null);
    expect(() => f.tasks().admit(f.scope, "b".repeat(64), f.now())).toThrow("conflict");
    f.tasks().cancel(owner, f.spec.id, f.now());
    controller.abort();
    await waiting;
    const retryId = randomUUID();
    f.queue().retry(owner, f.spec.id, retryId, f.now());
    const next = f.queue().claim(f.now())!;
    expect(f.queue().fail(f.scope, "interrupted", f.now())).toBe(false);
    expect(f.queue().release(f.scope, f.now())).toBe(false);
    expect(f.tasks().get(owner, f.spec.id).generation).toBe(next.lease.generation);
    f.tasks().cancel(owner, f.spec.id, f.now());
    expect(f.queue().retry(owner, f.spec.id, retryId, f.now()).state).toBe("cancelled");
    expect(f.queue().claim(f.now())).toBeNull();
  } finally {
    controller.abort();
    await f.close();
  }
});
