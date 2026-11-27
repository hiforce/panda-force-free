import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, copyFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { runPandaCli } from "../../src/cli/application.js";
import type { HarnessConversation, HarnessHistoryEvent } from "../../src/shared/harness/contracts.js";
import { runHarnessHistoryQuery } from "../../src/server/harness/history-cli.js";
import { save } from "../../src/server/harness/records.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { HarnessHistoryMaintenance } from "../../src/server/harness/storage/history-maintenance.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { organizationCli } from "../../src/server/project-memory/organization-tools.js";
import type { ModelReviewPort } from "../../src/server/project-memory/model-review.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";

const owner = "owner",
  projectId = "atlas";
const selection = { runtimeId: "test-organizer", model: "small", effort: "low" };
const day = 86_400_000;

test("organization uses only completed shared-history turns and never holds a foreground write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-memory-organization-"));
  const path = join(directory, "state.sqlite");
  let now = Date.UTC(2026, 10, 26),
    metadata = new SQLiteHarnessMetadata(path);
  const history = new JsonlHarnessHistory(directory, () => now);
  const id = randomUUID();
  const conversation: HarnessConversation = {
    id,
    owner,
    projectId,
    cwd: directory,
    title: "",
    runtimeId: "chat",
    revision: 0,
    lastSeq: 0,
    historyBytes: 0,
    activeRunId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const waiting = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let hold = false;
  const seen: string[][] = [];
  const models: ModelReviewPort = {
    async resolve(_owner, value) {
      return value;
    },
    async review() {
      throw Error("Legacy review must not be called");
    },
    async organize(_owner, used, context) {
      expect(used).toEqual(selection);
      seen.push(context.sources.map(({ user }) => user));
      if (hold) {
        waiting.resolve();
        await release.promise;
      }
      const cli = organizationCli({ ...context, job: "a".repeat(32) });
      const approved = context.sources.find(({ user }) => user.includes("24 hours"));
      await cli.submit(
        JSON.stringify({
          entries: approved
            ? [
                {
                  key: "cache ttl",
                  scope: "project",
                  value: "24 hours",
                  sourceId: approved.id,
                  quote: "24 hours",
                },
              ]
            : [],
        }),
      );
      return cli.result()!;
    },
  };
  const worker = () =>
    new ProjectMemory(
      metadata,
      history,
      async () => {},
      undefined,
      () => now,
      async () => ({ projectId, checkpoint: { throughBytes: 0, throughSeq: 0 } }),
      models,
    );
  let memory = worker();
  try {
    await metadata.transaction((tx) => save(tx, "conversation:" + id, "conversation", owner, conversation));
    const send = async (text: string) => {
      const userMessageId = randomUUID(),
        assistantMessageId = randomUUID(),
        runId = randomUUID();
      const seq = conversation.lastSeq + 1;
      await metadata.transaction(async (tx) => {
        const eligible = await memory.scope(conversation);
        const work = eligible && (await memory.organizationBoundary(tx, eligible, seq));
        const event: HarnessHistoryEvent = {
          type: "message",
          seq,
          message: {
            id: userMessageId,
            seq,
            runId,
            role: "user",
            text,
            runtimeId: "chat",
            model: "other-model",
            status: "complete",
            createdAt: now,
            attachments: [],
          },
        };
        conversation.lastSeq = seq + 1;
        conversation.historyBytes = await history.append(owner, id, conversation.historyBytes, [
          event,
          {
            type: "text",
            seq: seq + 1,
            messageId: assistantMessageId,
            text: "Understood",
          },
        ]);
        await save(tx, "conversation:" + id, "conversation", owner, conversation);
        await save(tx, "run:" + runId, "run", owner, {
          owner,
          conversationId: id,
          userMessageId,
          assistantMessageId,
          status: "complete",
        });
        if (work) await memory.organizations.enqueue(tx, work, conversation.historyBytes, seq);
      });
    };
    await memory.configure(owner, projectId, { revision: 0, write: true, recall: true });
    await send("Project convention: old rule = should never be parsed");
    now += 5 * 60_000;
    await memory.processPending();
    expect(seen).toEqual([]);
    await memory.configure(owner, projectId, {
      revision: 1,
      write: true,
      recall: true,
      model: { enabled: true, selection },
    });
    await send("We agreed to keep the cache for 24 hours.");
    await send("Can I ask another question?");
    await memory.close();
    await metadata.close();
    metadata = new SQLiteHarnessMetadata(path);
    memory = worker();
    hold = true;
    const organizing = memory.processPending();
    await waiting.promise;
    await send("Foreground can continue during model execution.");
    hold = false;
    release.resolve();
    await organizing;
    expect((await memory.catalog(owner, projectId))[0]).toMatchObject({ key: "cache-ttl", value: "24 hours" });
    await memory.processPending();
    expect(seen).toEqual([
      ["We agreed to keep the cache for 24 hours.", "Can I ask another question?"],
      ["Foreground can continue during model execution."],
    ]);
    expect((await memory.catalog(owner, projectId))[0]).toMatchObject({ key: "cache-ttl", value: "24 hours" });
    await metadata.transaction((tx) =>
      memory.configureSource(tx, conversation, { revision: 0, paused: true, revoke: false }),
    );
    await send("This was sent while memory was paused.");
    await metadata.transaction((tx) =>
      memory.configureSource(tx, conversation, { revision: 1, paused: false, revoke: false }),
    );
    await send("This was sent after resuming memory.");
    const task = await memory.backfills.start(
      { id, owner, projectId },
      { from: now - 7 * day, to: now + 1, requestId: randomUUID() },
    );
    expect(task.state).toBe("queued");
    await memory.backfills.processNext();
    expect(seen.at(-1)).toContain("This was sent after resuming memory.");
    expect(seen.at(-1)).not.toContain("This was sent while memory was paused.");
    expect(await memory.catalog(owner, projectId)).toHaveLength(1);
  } finally {
    release.resolve();
    await memory.close();
    await metadata.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("job-scoped Panda memory CLI rejects unrelated jobs and binds claims to exact source quotes", async () => {
  let result = "",
    errors = "";
  const output = new PassThrough(),
    error = new PassThrough();
  output.on("data", (data) => (result += data));
  error.on("data", (data) => (errors += data));
  const job = "a".repeat(32);
  expect(
    await runPandaCli(["memory", "context", "--job", job, "--json"], { input: Readable.from([]), output, error }),
  ).toBe(4);
  expect(JSON.parse(errors)).toMatchObject({ error: { code: "forbidden" } });
  const cli = organizationCli({ job, sources: [{ id: "one", user: "Keep the old configuration." }], existing: [] });
  expect(await cli.context()).toMatchObject({ job });
  await expect(
    cli.submit(
      '{"entries":[{"key":"configuration","scope":"project","sourceId":"other","quote":"Keep","value":"unchanged"}]}',
    ),
  ).rejects.toThrow();
  await expect(
    cli.submit(
      '{"entries":[{"key":"configuration","scope":"project","sourceId":"one","quote":"invented","value":"unchanged"}]}',
    ),
  ).rejects.toThrow();
  await expect(
    cli.submit(
      '{"entries":[{"key":"configuration","scope":"project","sourceId":"one","quote":"Keep","value":"unchanged"}]}',
    ),
  ).resolves.toEqual({ accepted: 1 });
  await expect(cli.submit('{"entries":[]}')).rejects.toThrow();
  expect(result).toBe("");
});

test("weekly archive verifies before removing bytes and preserves old source references and byte offsets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-history-archives-"));
  let now = Date.UTC(2026, 9, 1);
  const first = now,
    id = randomUUID();
  const history = new JsonlHarnessHistory(directory, () => now);
  const metadata = new SQLiteHarnessMetadata(join(directory, "metadata.sqlite"));
  const archive = new HarnessHistoryMaintenance(metadata, history, () => now);
  let bytes = 0,
    seq = 0;
  const saveConversation = () =>
    metadata.transaction((tx) =>
      save(tx, "conversation:" + id, "conversation", owner, {
        id,
        owner,
        lastSeq: seq,
        historyBytes: bytes,
        activeRunId: null,
      }),
    );
  const add = async (text: string) => {
    const messageId = randomUUID();
    bytes = await history.append(owner, id, bytes, [
      {
        type: "message",
        seq: ++seq,
        message: {
          id: messageId,
          seq,
          runId: randomUUID(),
          role: "user",
          runtimeId: "chat",
          model: null,
          text,
          createdAt: now,
          attachments: [],
          status: "complete",
        },
      },
    ]);
    await saveConversation();
    return { messageId, throughBytes: bytes, recordedAt: now };
  };
  try {
    const old = await add("first archive");
    now += 32 * day;
    const recent = await add("hot history");
    const { path } = await history.reference(owner, id, bytes);
    const physical = async () => (await stat(path)).size;
    const original = await readFile(path);
    const prepared = await history.prepareRotation(owner, id, bytes, new AbortController().signal);
    expect(prepared).toBeDefined();
    await prepared?.discard();
    expect(await readFile(path)).toEqual(original);
    await archive.run();
    expect(await physical()).toBe(bytes - old.throughBytes);
    await copyFile(path, path + ".restored");
    await rename(path + ".restored", path);
    expect((await history.messageAt(owner, id, bytes, old))?.text).toBe("first archive");
    expect((await history.messageAt(owner, id, bytes, recent))?.text).toBe("hot history");
    const after = await add("after rotation");
    expect(after.throughBytes).toBeGreaterThan(recent.throughBytes);
    expect(
      (
        await runHarnessHistoryQuery([
          "--file",
          path,
          "--committed-bytes",
          String(bytes),
          "--from",
          new Date(first - 1).toISOString(),
          "--to",
          new Date(now).toISOString(),
          "--query",
          "first archive",
        ])
      ).records,
    ).toMatchObject([{ text: "first archive" }]);
    now += 2 * day;
    await archive.run();
    let names = await readdir(join(path, ".."));
    expect(names.filter((name) => name.endsWith(".zip"))).toHaveLength(1);
    now += 31 * day;
    await archive.run();
    expect(await physical()).toBe(0);
    expect((await history.scanUserMessages(owner, id, bytes, 0)).messages.map(({ message }) => message.text)).toEqual([
      "first archive",
      "hot history",
      "after rotation",
    ]);
    names = await readdir(join(path, ".."));
    expect(names.filter((name) => name.endsWith(".zip"))).toHaveLength(2);
    await add("fresh");
    expect((await history.read(owner, id, bytes)).map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
  } finally {
    await archive.close();
    await metadata.close();
    await rm(directory, { recursive: true, force: true });
  }
});
