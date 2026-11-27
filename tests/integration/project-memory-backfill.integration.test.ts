import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessError, type HarnessHistoryEvent } from "../../src/shared/harness/contracts.js";
import type { HarnessHistory } from "../../src/server/harness/ports.js";
import { save } from "../../src/server/harness/records.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import { conversationKey, type MemoryConversation } from "../../src/server/project-memory/records.js";
import { organizationCli } from "../../src/server/project-memory/organization-tools.js";
import { extractMemoryClaims } from "../../src/server/project-memory/rules.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

for (const backend of ["SQLite", "MySQL"] as const)
  test.skipIf(backend === "MySQL" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    backend + " resumes an explicit model organization task and fences pending work after withdrawal",
    async () => {
      const mysql = backend === "MySQL" ? await isolatedMySQLDatabase("membkfill") : undefined;
      const root = await mkdtemp(join(tmpdir(), "memory-backfill-"));
      const db = () =>
        mysql ? new MySQLHarnessMetadata(mysql.sql) : new SQLiteHarnessMetadata(join(root, "harness.sqlite"));
      const first = db(),
        second = db();
      const now = Date.UTC(2026, 10, 26, 11);
      const owner = "alice",
        projectId = "atlas",
        id = randomUUID(),
        legacyId = randomUUID();
      const conversation: MemoryConversation = {
        id,
        owner,
        projectId,
        cwd: root,
        historyBytes: 0,
        lastSeq: 0,
        revision: 1,
        archivedAt: null,
        activeRunId: null,
      };
      const available = new Set([owner]);
      const durable = new JsonlHarnessHistory(join(root, "history"), () => now);
      let afterRead: (() => Promise<void>) | undefined;
      let shouldFail = false;
      const history = new Proxy<HarnessHistory>(durable, {
        get(target, name, receiver) {
          if (name !== "scanUserMessages") {
            const value = Reflect.get(target, name, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: Parameters<HarnessHistory["scanUserMessages"]>) => {
            if (shouldFail) throw Error("injected read failure");
            const page = await durable.scanUserMessages(...args);
            await afterRead?.();
            return page;
          };
        },
      });
      let linked: { throughBytes: number; throughSeq: number };
      let clock = now;
      let modelCalls = 0;
      const memory = (store: typeof first) =>
        new ProjectMemory(
          store,
          history,
          async (source, access) => {
            if (access === "contribute" && !available.has(source.owner)) throw new HarnessError("forbidden", 403);
          },
          undefined,
          () => clock,
          async (session) => ({ projectId, checkpoint: session === id ? linked : null }),
          {
            resolve: async (_owner, selection) => selection,
            review: async () => {
              throw Error("Legacy review must not run");
            },
            organize: async (_owner, selection, context) => {
              expect(selection).toEqual({ runtimeId: "mock", model: "fixture", effort: "low" });
              modelCalls++;
              const cli = organizationCli({ ...context, job: "a".repeat(32) });
              await cli.submit(
                JSON.stringify({
                  entries: context.sources.flatMap(({ id, user }) =>
                    extractMemoryClaims(user).map(({ key, scope, value }) => ({
                      key,
                      scope,
                      value,
                      sourceId: id,
                      quote: user.trim(),
                    })),
                  ),
                }),
              );
              return cli.result()!;
            },
          },
        );
      const active = memory(first),
        reopened = memory(second);
      const request = () => ({ from: now - 5000, to: now + 1000, requestId: randomUUID() });
      const truncate = (text: string) => text + " ".repeat(2000);
      async function turn(
        key: string,
        stamp = now,
        state: "complete" | "prepared" | "cancelled" = "complete",
        imported = false,
      ) {
        const runId = randomUUID(),
          messageId = randomUUID(),
          assistantId = randomUUID();
        const seq = conversation.lastSeq + 1;
        const event: HarnessHistoryEvent = {
          type: "message",
          seq,
          message: {
            id: messageId,
            seq,
            runId,
            role: "user",
            runtimeId: imported ? "import" : "codex",
            model: null,
            text: truncate(`Project convention [release]: ${key} = verified`),
            attachments: [],
            status: "complete",
            createdAt: stamp,
          },
        };
        await first.transaction(async (tx) => {
          conversation.historyBytes = await durable.append(owner, id, conversation.historyBytes, [event]);
          conversation.lastSeq = seq;
          conversation.activeRunId = state === "prepared" ? runId : null;
          await save(tx, conversationKey(id), "conversation", owner, conversation);
          await save(tx, `run:${runId}`, "run", owner, {
            id: runId,
            owner,
            conversationId: id,
            userMessageId: messageId,
            assistantMessageId: assistantId,
            status: state,
          });
        });
        return { runId, messageId, throughBytes: conversation.historyBytes };
      }
      const names = async () => (await active.catalog(owner, projectId)).map(({ key }) => key).sort();
      async function finish(worker: ProjectMemory) {
        for (let count = 0; count < 12; count++) {
          await worker.backfills.processNext();
          const { task } = await worker.backfills.view({ owner, projectId, id });
          if (task?.state === "complete") return task;
        }
        throw Error("history scan did not complete");
      }
      try {
        if (mysql)
          await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        await turn("before binding");
        linked = { throughBytes: conversation.historyBytes, throughSeq: conversation.lastSeq };
        const firstMatch = await turn("alpha");
        await turn("expired", now - 60_000);
        await turn("password");
        await turn("cancelled", now, "cancelled");
        await turn("imported", now, "complete", true);
        for (let index = 0; index < 10; index++) await turn(`body ${index}`);
        const unfinished = await turn("unfinished at scheduling", now, "prepared");
        const destination = { id, owner, projectId };
        await expect(active.backfills.start(destination, request())).rejects.toMatchObject({ code: "conflict" });
        await active.configure(owner, projectId, {
          revision: 0,
          write: true,
          recall: true,
          model: { enabled: true, selection: { runtimeId: "mock", model: "fixture", effort: "low" } },
        });
        await first.transaction((tx) =>
          save(tx, conversationKey(legacyId), "conversation", owner, { ...conversation, id: legacyId }),
        );
        expect(await active.backfills.view({ ...destination, id: legacyId })).toMatchObject({
          availability: "boundaryUnavailable",
        });
        expect(await active.backfills.view({ ...destination, owner: "bob" })).toEqual({
          availability: "forbidden",
          task: null,
        });
        await expect(active.backfills.start({ ...destination, projectId: "another" }, request())).rejects.toMatchObject(
          {
            code: "forbidden",
          },
        );
        available.clear();
        await expect(active.backfills.start(destination, request())).rejects.toMatchObject({ code: "forbidden" });
        available.add(owner);

        const intent = request();
        const queued = await active.backfills.start(destination, intent);
        expect(queued).toMatchObject({ state: "queued", progress: 0 });
        expect(await reopened.backfills.start(destination, intent)).toEqual(queued);
        await expect(reopened.backfills.start(destination, { ...intent, from: now - 6000 })).rejects.toMatchObject({
          code: "conflict",
        });
        await first.transaction(async (tx) => {
          conversation.activeRunId = null;
          await save(tx, conversationKey(id), "conversation", owner, conversation);
          await save(tx, `run:${unfinished.runId}`, "run", owner, {
            owner,
            conversationId: id,
            userMessageId: unfinished.messageId,
            status: "complete",
          });
        });
        await turn("submitted after snapshot");
        await active.backfills.processNext();
        const before = (await reopened.backfills.view(destination)).task!;
        expect(before.state).toBe("queued");
        expect(before.progress).toBeGreaterThan(0);
        expect(before.added).toBeGreaterThan(0);
        shouldFail = true;
        await reopened.backfills.processNext();
        expect((await reopened.backfills.view(destination)).task).toMatchObject({
          state: "queued",
          progress: before.progress,
          added: before.added,
        });
        shouldFail = false;
        clock += 5000;
        expect(await finish(reopened)).toMatchObject({ progress: 100, added: 11 });
        expect(await active.backfills.start(destination, intent)).toMatchObject({ state: "complete", added: 11 });
        expect(await names()).toEqual(["alpha", ...Array.from({ length: 10 }, (_, index) => `body-${index}`)]);
        expect(await active.sourceLocation(owner, projectId, id, firstMatch.messageId)).toMatchObject({
          message: { id: firstMatch.messageId, text: expect.stringContaining("alpha") },
        });
        expect(await active.catalog("bob", projectId)).toEqual([]);

        await turn("withdraw during scan");
        const newIntent = request();
        expect(await active.backfills.start(destination, newIntent)).toMatchObject({ state: "queued" });
        const read = Promise.withResolvers<void>(),
          resume = Promise.withResolvers<void>();
        afterRead = async () => {
          read.resolve();
          await resume.promise;
        };
        const scanning = active.backfills.processNext();
        await read.promise;
        await second.transaction((tx) =>
          reopened.configureSource(tx, conversation, { revision: 0, write: null, recall: null, revoke: true }),
        );
        expect(await names()).toEqual([]);
        resume.resolve();
        await scanning;
        afterRead = undefined;
        expect((await reopened.backfills.view(destination)).task).toMatchObject({ state: "stopped", added: 0 });
        await turn("after withdrawal");
        await reopened.backfills.start(destination, request());
        expect(await finish(reopened)).toMatchObject({ added: 1 });
        expect(await names()).toEqual(["after-withdrawal"]);

        await turn("expired worker lease");
        await active.backfills.start(destination, request());
        const claim = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        afterRead = async () => {
          claim.resolve();
          await release.promise;
        };
        const delayed = active.backfills.processNext();
        try {
          await claim.promise;
          expect((await reopened.backfills.view(destination)).task).toMatchObject({ state: "running", added: 0 });
          await reopened.backfills.processNext();
          expect(await names()).toEqual(["after-withdrawal"]);
          clock += 181_000;
          afterRead = undefined;
          expect(await finish(reopened)).toMatchObject({ added: 1 });
        } finally {
          release.resolve();
          await delayed;
        }
        expect(await names()).toEqual(["after-withdrawal", "expired-worker-lease"]);
        expect((await active.backfills.view(destination)).task).toMatchObject({ state: "complete", added: 1 });

        for (let index = 0; index < 15; index++) await turn(`during shutdown ${index}`);
        await active.backfills.start(destination, request());
        const pageRead = Promise.withResolvers<void>();
        const finishPage = Promise.withResolvers<void>();
        let pagesRead = 0;
        afterRead = async () => {
          pagesRead++;
          pageRead.resolve();
          await finishPage.promise;
        };
        active.wake();
        await pageRead.promise;
        const stopping = active.close();
        finishPage.resolve();
        await stopping;
        afterRead = undefined;
        expect(pagesRead).toBe(1);
        const checkpoint = (await reopened.backfills.view(destination)).task;
        expect(checkpoint).toMatchObject({ state: "queued", added: 0, progress: 0 });
        await reopened.backfills.processReady(new AbortController().signal);
        expect((await reopened.backfills.view(destination)).task).toMatchObject({
          state: "complete",
          progress: 100,
          added: 15,
        });
        const existing = (await reopened.catalog(owner, projectId)).find(({ key }) => key === "after-withdrawal")!;
        const reference = { id: existing.id, version: existing.version!, sources: existing.sources, projectId };
        expect(await reopened.bindingIsCurrent(conversation, [reference])).toBe(true);
        const setPaused = async (paused: boolean) => {
          const source = await reopened.source(id);
          return second.transaction((tx) =>
            reopened.configureSource(tx, conversation, { revision: source.revision, paused, revoke: false }),
          );
        };

        const previouslyAcceptedSeq = conversation.lastSeq;
        expect((await setPaused(true)).paused).toBe(true);
        expect(await reopened.bindingIsCurrent(conversation, [reference])).toBe(false);
        expect(await reopened.backfills.view(destination)).toMatchObject({ availability: "paused" });
        await expect(reopened.backfills.start(destination, request())).rejects.toMatchObject({ code: "conflict" });
        await turn("private while paused");
        expect(await reopened.acceptsTurn(id, conversation.lastSeq)).toBe(false);
        expect((await setPaused(false)).paused).toBe(false);
        expect(await reopened.acceptsTurn(id, previouslyAcceptedSeq)).toBe(false);
        expect(await reopened.acceptsTurn(id, conversation.lastSeq)).toBe(false);
        expect(await reopened.bindingIsCurrent(conversation, [reference])).toBe(true);
        await turn("permitted after resume");
        expect(await reopened.acceptsTurn(id, conversation.lastSeq)).toBe(true);
        await reopened.backfills.start(destination, request());
        await reopened.backfills.processReady(new AbortController().signal);
        expect((await reopened.backfills.view(destination)).task).toMatchObject({ added: 1, state: "complete" });
        const afterResume = await names();
        expect(afterResume).toContain("permitted-after-resume");
        expect(afterResume).not.toContain("private-while-paused");
        expect(modelCalls).toBeGreaterThan(0);
      } finally {
        await active.close();
        await reopened.close();
        await first.close();
        await second.close();
        await mysql?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    75_000,
  );
