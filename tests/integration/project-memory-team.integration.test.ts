import {
  memoryFixtureOrganizer,
  memoryFixturePolicy,
  runDueMemory,
  stageCompletedMemory,
} from "../support/memory-organization.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "../../src/shared/harness/contracts.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { save } from "../../src/server/harness/records.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { conversationKey, type MemoryConversation } from "../../src/server/project-memory/records.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

for (const backend of ["SQLite", "MySQL"] as const)
  test.skipIf(backend === "MySQL" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    backend + " shares exact approved conventions across owners and fences revoked evidence, exports and bindings",
    async () => {
      const mysql = backend === "MySQL" ? await isolatedMySQLDatabase("memteam") : undefined;
      const root = await mkdtemp(join(tmpdir(), "panda-team-memory-"));
      const connection = () =>
        mysql ? new MySQLHarnessMetadata(mysql.sql) : new SQLiteHarnessMetadata(join(root, "harness.sqlite"));
      const store = connection();
      const peerStore = connection();
      const history = new JsonlHarnessHistory(join(root, "history"));
      const projectId = "atlas",
        otherProject = "harbor";
      let now = Date.now();
      const access = new Set(["alice", "bob", "carol"]);
      const auth = async (source: MemoryConversation) => {
        if (!access.has(source.owner)) throw new HarnessError("notFound", 404);
      };
      const memory = new ProjectMemory(store, history, auth, undefined, () => now, undefined, memoryFixtureOrganizer);
      const peer = new ProjectMemory(peerStore, history, auth, undefined, () => now, undefined, memoryFixtureOrganizer);
      const conversation = (owner: string, project = projectId): MemoryConversation => ({
        id: randomUUID(),
        owner,
        projectId: project,
        revision: 0,
        cwd: root,
        archivedAt: null,
        historyBytes: 0,
        lastSeq: 0,
        title: "Private source title",
      });
      async function learn(source: MemoryConversation, text: string) {
        now += 10;
        const { owner, id } = source;
        const messageId = randomUUID();
        const runId = randomUUID();
        const seq = ++source.lastSeq;
        source.historyBytes = await history.append(owner, id, source.historyBytes, [
          {
            type: "message",
            seq,
            message: {
              id: messageId,
              seq,
              runId,
              runtimeId: "codex",
              role: "user",
              model: null,
              attachments: [],
              status: "complete",
              createdAt: now,
              text,
            },
          },
          {
            type: "message",
            seq: ++source.lastSeq,
            message: {
              id: randomUUID(),
              seq: source.lastSeq,
              runId,
              runtimeId: "codex",
              role: "assistant",
              model: null,
              attachments: [],
              status: "complete",
              createdAt: now,
              text: "Reply",
            },
          },
        ]);
        await store.transaction(async (tx) => {
          await save(tx, conversationKey(id), "conversation", owner, source);
          await stageCompletedMemory(tx, memory, source, { id: messageId, runId, seq });
        });
        await runDueMemory(store, memory);
        return messageId;
      }
      try {
        if (mysql)
          await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        const source = conversation("alice"),
          receiver = conversation("bob"),
          alternate = conversation("carol");
        const unrelated = conversation("bob", otherProject);
        const question = "How long is the release artifact retention?";
        for (const { owner, projectId: project } of [source, receiver, alternate, unrelated])
          await memory.configure(owner, project!, {
            revision: 0,
            write: true,
            recall: true,
            model: memoryFixturePolicy,
          });
        const raw =
          "Private meeting details stay in the transcript.\nProject convention [release]: artifact retention = 30 days";
        await learn(source, raw);
        const [entry] = await memory.catalog(source.owner, projectId);
        const ask = () => peerStore.transaction((tx) => peer.recall(tx, receiver, question, []));
        expect(await ask()).toEqual([]);
        expect((await peer.teamView("bob", projectId, true)).entries).toEqual([]);
        await expect(peer.team.preview("bob", projectId, entry!.id)).rejects.toMatchObject({ code: "notFound" });
        const old = await memory.team.preview("alice", projectId, entry!.id);
        const messageId = await learn(source, "Replace project convention [release]: artifact retention = 14 days");
        await expect(memory.team.publish("alice", projectId, entry!.id, old.token)).rejects.toMatchObject({
          status: 409,
        });
        const preview = await memory.team.preview("alice", projectId, entry!.id);
        expect(preview).toEqual({
          entryId: entry!.id,
          key: "artifact-retention",
          scope: "release",
          value: "14 days",
          token: expect.any(String),
        });
        const publication = await memory.team.publish("alice", projectId, entry!.id, preview.token);
        expect(await memory.team.publish("alice", projectId, entry!.id, preview.token)).toEqual(publication);
        const same = await memory.team.preview("alice", projectId, entry!.id);
        expect(await memory.team.publish("alice", projectId, entry!.id, same.token)).toEqual(publication);
        expect(await peer.teamView("bob", otherProject, true)).toMatchObject({ entries: [], publications: [] });
        expect(await peer.teamView("bob", projectId, true)).toMatchObject({
          entries: [{ value: "14 days", sources: [], team: true }],
          publications: [],
        });
        expect(await memory.catalog("bob", projectId)).toEqual([]);
        expect((await peer.exportArchive("bob", projectId)).records).toEqual([]);
        await expect(peer.sourceLocation("bob", projectId, source.id, messageId)).rejects.toMatchObject({
          status: 404,
        });

        const [learnt] = await ask();
        expect(learnt).toMatchObject({ value: "14 days", sources: [], team: true });
        const reference = { id: learnt!.id, version: learnt!.version!, team: true, sources: [], projectId } as const;
        expect(await peer.bindingIsCurrent(receiver, [reference])).toBe(true);
        access.delete("alice");
        expect((await peer.teamView("bob", projectId, true)).entries).toEqual([]);
        expect(await ask()).toEqual([]);
        expect(await peer.bindingIsCurrent(receiver, [reference])).toBe(false);
        access.add("alice");

        await learn(alternate, "Project convention [release]: artifact retention = 45 days");
        const conflict = await memory.team.preview("carol", projectId, entry!.id);
        const conflicting = await memory.team.publish("carol", projectId, entry!.id, conflict.token);
        expect((await peer.teamView("bob", projectId, true)).entries).toEqual([]);
        expect(await ask()).toEqual([]);
        expect(await peer.bindingIsCurrent(receiver, [reference])).toBe(false);
        await memory.team.withdraw("carol", projectId, entry!.id, conflicting.revision);
        await expect(memory.team.publish("carol", projectId, entry!.id, conflict.token)).rejects.toMatchObject({
          status: 409,
        });
        expect(await ask()).toMatchObject([{ value: "14 days" }]);

        await learn(receiver, "Project convention [release]: artifact retention = 21 days");
        expect(await ask()).toEqual([]);
        expect((await peer.teamView("bob", projectId, true)).entries).toMatchObject([{ value: "14 days" }]);
        expect(await peer.bindingIsCurrent(receiver, [reference])).toBe(false);
        await store.transaction((tx) =>
          memory.configureSource(tx, source, { revision: 0, write: null, recall: null, revoke: true }),
        );
        expect((await peer.teamView("bob", projectId, true)).entries).toEqual([]);
        expect((await memory.teamView("alice", projectId, true)).publications).toMatchObject([{ active: false }]);
        await expect(memory.team.publish("alice", projectId, entry!.id, preview.token)).rejects.toMatchObject({
          status: 409,
        });
      } finally {
        await memory.close();
        await peer.close();
        await store.close();
        await peerStore.close();
        await mysql?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
