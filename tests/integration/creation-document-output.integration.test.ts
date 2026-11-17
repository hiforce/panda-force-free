import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CreationOutputs } from "../../src/server/creation/outputs.js";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";
import { FileCreationDocumentOutput } from "../../src/server/creation/integration/document-output.js";
import type { CreationOutputTasks } from "../../src/server/creation/ports.js";
import type { CreationTaskSpec } from "../../src/server/creation/contracts.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { documentCreationTools } from "../../src/server/creation/document-tools.js";

const owner = "operator:test-user",
  output = () => ({
    title: "An actual generated document",
    body: richDocumentFromMarkdown("## Summary\n\nSaved through the application tool."),
  });

async function fixture() {
  const files = await projectFileApiFixture(),
    databasePath = join(files.assetRoot, "creation.sqlite"),
    outputRoot = join(files.assetRoot, "outputs");
  let db = openCreationDatabase(databasePath),
    tasks = new CreationTaskRepository(db),
    now = 10000;
  const documents = () => new FileCreationDocumentOutput(outputRoot, files.application().navigation),
    outputs = (store: CreationOutputTasks = tasks) => {
      const adapter = documents();
      return new CreationOutputs(store, adapter, adapter, () => now);
    },
    parent = await files.application().navigation.create(owner, {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      title: "Parent",
      locale: "en",
    });
  const spec: CreationTaskSpec = {
    schema: 1,
    id: randomUUID(),
    operationId: randomUUID(),
    owner,
    projectId: "project-1",
    kind: "document",
    target: { parentId: parent.operation.documentId, treeVersion: parent.tree.version, locale: "en" },
    inputDigest: "a".repeat(64),
    skillCaptureId: randomUUID(),
  };
  tasks.create(spec, now);
  const lease = tasks.claim(owner, spec.id, now, 30000),
    scope = tasks.bind(lease, "owned-thread", "owned-turn", now);
  return {
    ...files,
    spec,
    scope,
    outputRoot,
    databasePath,
    outputs,
    documents,
    tasks: () => tasks,
    database: () => db,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    restart() {
      db.close();
      files.reopen();
      db = openCreationDatabase(databasePath);
      tasks = new CreationTaskRepository(db);
    },
    async close() {
      db.close();
      await files.close();
    },
  };
}
async function manualEdit(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const detail = await f.application().queries.editor("project-1", id),
    working = {
      title: "A newer manual title",
      locale: "en",
      content: "",
      resources: [],
      body: richDocumentFromMarkdown("The user edited this after generation."),
    };
  await f.application().editor.autosave(owner, "project-1", id, {
    operationId: randomUUID(),
    version: detail.draft.version,
    baseRevisionId: detail.saved.revision.id,
    working,
  });
  const snapshot = await f.application().queries.editor("project-1", id);
  await f.application().editor.save(owner, "project-1", id, {
    operationId: randomUUID(),
    draftVersion: snapshot.draft.version,
    revisionId: snapshot.saved.revision.id,
  });
}

test("an admitted output creates one real file-backed document and Git commit, with no document body in its task database", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshots.head(),
      generated = output(),
      result = await f.outputs().invoke(f.scope, generated);
    expect(result.state).toBe("succeeded");
    expect(result.artifact?.operationId).toBe(f.spec.operationId);
    const artifact = result.artifact!,
      head = await f.snapshots.head(),
      detail = await f.application().queries.detail("project-1", artifact.documentId),
      tree = await f.application().navigation.tree("project-1");
    expect(await f.snapshots.parent(head)).toBe(before);
    expect(tree.nodes.find((node) => node.documentId === artifact.documentId)?.parentId).toBe(f.spec.target.parentId);
    expect(detail.revision.body).toEqual(generated.body);
    expect(detail.document.revision).toBe(1);
    const stored = f.database().query("SELECT * FROM creation_tasks").get();
    expect(JSON.stringify(stored)).not.toContain("Saved through the application tool");
    expect((await readdir(f.outputRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    f.restart();
    await manualEdit(f, artifact.documentId);
    const editedHead = await f.snapshots.head(),
      replay = await f.outputs().reconcile(owner, f.spec.id);
    expect(replay.artifact).toEqual(artifact);
    expect(await f.snapshots.head()).toBe(editedHead);
    expect((await f.application().queries.detail("project-1", artifact.documentId)).revision.content).toContain(
      "user edited",
    );
    expect(() => f.tasks().create({ ...f.spec, target: { ...f.spec.target, parentId: null } }, f.now())).toThrow(
      "conflict",
    );
    expect(() => f.tasks().get("operator:another-user", f.spec.id)).toThrow("notFound");
  } finally {
    await f.close();
  }
}, 30000);

test("a crash after Git commit recovers its original receipt without creating a duplicate or reverting a later manual revision", async () => {
  const f = await fixture();
  try {
    const store: CreationOutputTasks = {
      get: f.tasks().get.bind(f.tasks()),
      assertExecution: f.tasks().assertExecution.bind(f.tasks()),
      admit: f.tasks().admit.bind(f.tasks()),
      outputFailure: f.tasks().outputFailure.bind(f.tasks()),
      complete: () => {
        throw new Error("Process stopped after the project commit");
      },
    };
    await expect(f.outputs(store).invoke(f.scope, output())).rejects.toThrow("Process stopped");
    expect(f.tasks().get(owner, f.spec.id).state).toBe("committing");
    const tree = await f.application().navigation.tree("project-1"),
      generated = tree.nodes.find((node) => node.document.title === output().title)!;
    expect(generated).toBeDefined();
    await manualEdit(f, generated.documentId);
    const before = await f.snapshots.head();
    f.restart();
    expect(
      f
        .tasks()
        .pending()
        .map((task) => task.spec.id),
    ).toEqual([f.spec.id]);
    const recovered = await f.outputs().reconcile(owner, f.spec.id);
    expect(recovered.state).toBe("succeeded");
    expect(recovered.artifact?.documentId).toBe(generated.documentId);
    expect(await f.snapshots.head()).toBe(before);
    const detail = await f.application().queries.detail("project-1", generated.documentId);
    expect(detail.document.title).toBe("A newer manual title");
    expect(detail.document.revision).toBe(2);
    expect(f.tasks().pending()).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

test("a newer execution and cancellation fence late model callbacks before they can alter any project file", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshots.head();
    f.advance(30001);
    const lease = f.tasks().claim(owner, f.spec.id, f.now(), 30000),
      current = f.tasks().bind(lease, "new-thread", "new-turn", f.now());
    for (const stale of [
      f.scope,
      { ...current, sessionId: "foreign-thread" },
      { ...current, runId: "old-turn" },
      { ...current, owner: "operator:another-user" },
      { ...current, token: "forged" },
    ]) {
      await expect(f.outputs().invoke(stale, output())).rejects.toBeDefined();
    }
    expect(await f.snapshots.head()).toBe(before);
    let unblock!: () => void, staged!: () => void;
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        staged = resolve;
      }),
      adapter = f.documents(),
      guarded = new CreationOutputs(
        f.tasks(),
        {
          async stage(value) {
            const digest = await adapter.stage(value);
            staged();
            await gate;
            return digest;
          },
        },
        adapter,
        f.now,
      ),
      pending = guarded.invoke(current, output());
    await ready;
    f.tasks().cancel(owner, f.spec.id, f.now());
    unblock();
    await expect(pending).rejects.toThrow("leaseLost");
    expect(f.tasks().get(owner, f.spec.id).outputDigest).toBeNull();
    expect(await f.snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);

test("cancellation after durable admission retains the real artifact and suppresses all further tool writes", async () => {
  const f = await fixture();
  try {
    const adapter = f.documents();
    let unblock!: () => void, admitted!: () => void;
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        admitted = resolve;
      }),
      service = new CreationOutputs(
        f.tasks(),
        adapter,
        {
          async commit(task, digest) {
            admitted();
            await gate;
            return adapter.commit(task, digest);
          },
        },
        f.now,
      ),
      pending = service.invoke(f.scope, output());
    await ready;
    expect(f.tasks().cancel(owner, f.spec.id, f.now()).state).toBe("committing");
    await expect(f.outputs().invoke(f.scope, output())).rejects.toThrow("leaseLost");
    unblock();
    const completed = await pending;
    expect(completed.state).toBe("cancelled");
    expect(completed.cancelRequested).toBe(true);
    expect(completed.artifact).not.toBeNull();
    f.restart();
    expect((await f.outputs().reconcile(owner, f.spec.id)).artifact).toEqual(completed.artifact);
  } finally {
    await f.close();
  }
}, 30000);

test("two concurrent tool calls share the first admitted output, even when a later callback supplies different text", async () => {
  const f = await fixture();
  try {
    const adapter = f.documents();
    let unblock!: () => void, admitted!: () => void;
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        admitted = resolve;
      }),
      service = new CreationOutputs(
        f.tasks(),
        adapter,
        {
          async commit(task, digest) {
            admitted();
            await gate;
            return adapter.commit(task, digest);
          },
        },
        f.now,
      ),
      first = service.invoke(f.scope, output());
    await ready;
    const second = service.invoke(f.scope, {
      title: "Do not create a second document",
      body: richDocumentFromMarkdown("Different model retry"),
    });
    unblock();
    const [a, b] = await Promise.all([first, second]);
    expect(a.artifact).toEqual(b.artifact);
    const tree = await f.application().navigation.tree("project-1");
    expect(tree.nodes.filter((node) => node.document.title === output().title)).toHaveLength(1);
    expect(tree.nodes.some((node) => node.document.title === "Do not create a second document")).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

test("model-supplied authority fields, invalid rich blocks and foreign asset IDs are rejected before admission", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshots.head();
    for (const value of [
      { ...output(), projectId: "foreign-project" },
      { ...output(), operationId: randomUUID() },
      { ...output(), path: "/tmp/arbitrary.md" },
      { ...output(), owner: "operator:another-user" },
      { ...output(), body: { schema: 1, format: "richtext", document: { type: "script", text: "alert(1)" } } },
      {
        ...output(),
        body: {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [{ type: "image", attrs: { src: "/api/document-assets/content?id=" + randomUUID() } }],
          },
        },
      },
    ])
      await expect(f.outputs().invoke(f.scope, value)).rejects.toThrow("invalidOutput");
    expect(f.tasks().get(owner, f.spec.id).state).toBe("running");
    expect(await f.snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);

test("a changed document directory rejects a stale creation intent and preserves the generated file for explicit recovery", async () => {
  const f = await fixture();
  try {
    await f.application().navigation.create(owner, {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: f.spec.target.treeVersion,
      parentId: null,
      title: "Concurrent manual document",
      locale: "en",
    });
    const before = await f.snapshots.head();
    await expect(f.outputs().invoke(f.scope, output())).rejects.toThrow("targetChanged");
    expect(await f.snapshots.head()).toBe(before);
    const pending = f.tasks().get(owner, f.spec.id);
    expect(pending.state).toBe("committing");
    expect(pending.outputDigest).not.toBeNull();
    expect(pending.artifact).toBeNull();
    expect(pending.failure).toBe("targetChanged");
    f.restart();
    await expect(f.outputs().reconcile(owner, f.spec.id)).rejects.toThrow("targetChanged");
    expect(await f.snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);

test("the engine-neutral document tool binds one task and returns its real artifact on changed-text retries after manual editing", async () => {
  const f = await fixture();
  try {
    const lease = { taskId: f.scope.taskId, owner, token: f.scope.token, generation: f.scope.generation },
      tools = documentCreationTools(lease, f.tasks(), f.outputs(), f.now),
      scope = { sessionId: f.scope.sessionId, runId: f.scope.runId },
      call = { ...scope, callId: "first", name: "panda_documents_create", arguments: output() };
    expect(JSON.stringify(tools.definitions)).not.toContain(f.spec.projectId);
    tools.started(scope);
    lease.owner = "operator:changed-caller";
    const unchangedHead = await f.snapshots.head(),
      rejected = await tools.call({
        ...call,
        arguments: {
          title: "Invalid draft",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [
                {
                  type: "blockquote",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Private document content" }] }],
                    },
                  ],
                },
              ],
            },
          },
        },
      });
    expect(rejected.success).toBe(false);
    expect(JSON.parse(rejected.text)).toMatchObject({
      error: "invalidOutput",
      retryable: true,
      expectedBody: { schema: 1, format: "richtext", document: { type: "doc" } },
    });
    expect(rejected.text).not.toContain("Private document content");
    expect(await f.snapshots.head()).toBe(unchangedHead);
    expect(f.tasks().get(owner, f.spec.id).outputDigest).toBeNull();
    const result = await tools.call(call),
      artifact = JSON.parse(result.text);
    expect(result.success).toBe(true);
    expect(artifact.operationId).toBe(f.spec.operationId);
    await manualEdit(f, artifact.documentId);
    const head = await f.snapshots.head();
    const retry = await tools.call({
      ...call,
      callId: "second",
      arguments: { ...output(), title: "A replacement request" },
    });
    expect(JSON.parse(retry.text)).toEqual(artifact);
    expect(await f.snapshots.head()).toBe(head);
    expect((await f.application().queries.detail("project-1", artifact.documentId)).document.title).toBe(
      "A newer manual title",
    );
    for (const foreign of [
      { ...call, sessionId: "foreign" },
      { ...call, runId: "foreign" },
      { ...call, name: "shell" },
    ])
      await expect(tools.call(foreign)).rejects.toThrow("leaseLost");
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    await f.close();
  }
}, 30000);
