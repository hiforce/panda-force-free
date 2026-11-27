import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import type { HarnessMetadataTransaction } from "../../src/server/harness/ports.js";
import { save } from "../../src/server/harness/records.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import {
  conversationKey,
  digest,
  entryId,
  evidenceKey,
  evidenceKind,
  namespace,
  type MemoryConversation,
  type MemoryEvidence,
  type MemoryRecall,
} from "../../src/server/project-memory/records.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

for (const backend of ["SQLite", "MySQL"] as const)
  test.skipIf(backend === "MySQL" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    backend + " checks only relevant sources in a dense project and immediately fences a withdrawn reference",
    async () => {
      const mysql = backend === "MySQL" ? await isolatedMySQLDatabase("memscale") : undefined;
      const root = await mkdtemp(join(tmpdir(), "panda-memory-scale-"));
      const connect = () =>
        mysql ? new MySQLHarnessMetadata(mysql.sql) : new SQLiteHarnessMetadata(join(root, "harness.sqlite"));
      const store = connect();
      const writer = connect();
      const project = "atlas";
      const assignments = new Map<string, string>();
      const sourceChecks = new Set<string>();
      const grantChecks: string[] = [];
      let brokenAuthor: string | undefined;
      const memory = new ProjectMemory(
        store,
        new JsonlHarnessHistory(join(root, "history")),
        async (source, access) => {
          if (access === "contribute") {
            grantChecks.push(source.id);
            if (source.id === brokenAuthor) throw new Error("Temporary contributor authorization failure");
          }
        },
        undefined,
        undefined,
        async (id) => {
          sourceChecks.add(id);
          const projectId = assignments.get(id);
          return projectId ? { projectId, checkpoint: null } : null;
        },
      );
      const conversation = (owner: string, projectId = project): MemoryConversation => {
        const id = randomUUID();
        assignments.set(id, projectId);
        return { id, owner, projectId, revision: 1, cwd: root, archivedAt: null, historyBytes: 200, lastSeq: 2 };
      };
      const receiver = conversation("reader");
      const elsewhere = conversation(receiver.owner, "harbor");
      const general = conversation("maintainer");
      const release = conversation(general.owner);
      const unrelated = conversation("another-author");
      const ask = (prompt: string, session = receiver) =>
        store.transaction((tx) => memory.recall(tx, session, prompt, []));
      const saveConversation = (tx: HarnessMetadataTransaction, source: MemoryConversation) =>
        save(tx, conversationKey(source.id), "conversation", source.owner, source);
      async function evidence(
        tx: HarnessMetadataTransaction,
        source: MemoryConversation,
        key: string,
        scope: string,
        value: string,
      ) {
        const id = digest([source.id, key, scope]);
        await save(tx, evidenceKey(id), evidenceKind, namespace(source.owner, project), {
          id,
          key,
          scope,
          value,
          recordedAt: 1,
          conversationId: source.id,
          messageId: randomUUID(),
          generation: 0,
          throughBytes: 150,
          replaces: false,
        } satisfies MemoryEvidence);
        return id;
      }

      const key = "cache-window";
      const prompt = "What is the release cache window?";
      const clearChecks = () => {
        sourceChecks.clear();
        grantChecks.length = 0;
      };
      try {
        if (mysql)
          await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        await writer.transaction(async (tx) => {
          for (const source of [receiver, elsewhere, general, release, unrelated]) await saveConversation(tx, source);
          await evidence(tx, general, key, "project", "48 hours");
          await evidence(tx, release, key, "release", "24 hours");
          // Seed committed evidence and grants at capacity. The two queried grants use the real approval flow.
          for (let i = 0; i < 254; i++) {
            const topic = "shared-topic-" + i;
            const id = entryId(topic, "project");
            const proof = await evidence(tx, unrelated, topic, "project", "Unrelated convention");
            await save(
              tx,
              "memory-team:" + digest([unrelated.owner, project, id]),
              "project-memory-team-grant",
              "pmt:" + digest(project),
              {
                owner: unrelated.owner,
                project,
                entryId: id,
                key: topic,
                scope: "project",
                proofs: [{ id: proof, generation: 0 }],
                previewToken: digest(proof),
              },
            );
          }
          for (let i = 0; i < 1024; i++) {
            const source = conversation(receiver.owner);
            await saveConversation(tx, source);
            await evidence(tx, source, "private-topic-" + i, "project", "Unrelated private convention");
          }
        });
        await memory.configure(receiver.owner, project, { revision: 0, write: true, recall: true });
        await memory.configure(elsewhere.owner, elsewhere.projectId!, { revision: 0, write: true, recall: true });
        for (const scope of ["project", "release"]) {
          const id = entryId(key, scope);
          const preview = await memory.team.preview(general.owner, project, id);
          await memory.team.publish(general.owner, project, id, preview.token);
        }
        clearChecks();
        expect((await memory.teamView(receiver.owner, project, false)).entries).toHaveLength(256);
        expect(grantChecks).toHaveLength(256);
        expect(new Set(grantChecks)).toEqual(new Set([general.id, release.id, unrelated.id]));

        brokenAuthor = unrelated.id;
        clearChecks();
        const [result] = await ask(prompt);
        expect(result).toMatchObject({ key, scope: "release", value: "24 hours", team: true });
        expect(sourceChecks).toEqual(new Set([receiver.id, general.id, release.id]));
        expect(grantChecks).toHaveLength(2);
        expect(new Set(grantChecks)).toEqual(new Set([general.id, release.id]));
        const reference: MemoryRecall = {
          id: result!.id,
          version: result!.version!,
          sources: [],
          team: true,
          projectId: project,
        };

        clearChecks();
        expect(await ask("What was the deployment date?")).toEqual([]);
        expect(sourceChecks).toEqual(new Set([receiver.id]));
        expect(grantChecks).toHaveLength(0);
        expect(await ask(prompt, elsewhere)).toEqual([]);

        clearChecks();
        expect(await memory.bindingIsCurrent(receiver, [reference])).toBe(true);
        expect(sourceChecks).toEqual(new Set([receiver.id, release.id]));
        expect(grantChecks).toEqual([release.id]);
        const runId = randomUUID();
        await writer.transaction((tx) =>
          memory.recordRecall(tx, receiver, { runId, nativeSessionId: "native", status: "sent", references: [reference] }),
        );
        clearChecks();
        expect(await memory.recalls(receiver)).toMatchObject([{ runId, references: [{ id: reference.id, team: true }] }]);
        expect(sourceChecks).toEqual(new Set([receiver.id, release.id]));

        brokenAuthor = release.id;
        expect(await ask(prompt)).toEqual([]);
        expect(await memory.bindingIsCurrent(receiver, [reference])).toBe(false);
        brokenAuthor = unrelated.id;

        const conflict = conversation(receiver.owner);
        await writer.transaction(async (tx) => {
          await saveConversation(tx, conflict);
          await evidence(tx, conflict, key, "release", "12 hours");
        });
        clearChecks();
        expect(await ask(prompt)).toEqual([]);
        expect(sourceChecks).toEqual(new Set([receiver.id, general.id, release.id, conflict.id]));
        expect(await memory.bindingIsCurrent(receiver, [reference])).toBe(false);

        await writer.transaction(async (tx) => {
          await memory.configureSource(tx, conflict, { revision: 0, write: null, recall: null, revoke: true });
        });
        expect(await memory.bindingIsCurrent(receiver, [reference])).toBe(true);
        await writer.transaction(async (tx) => {
          await memory.configureSource(tx, release, { revision: 0, write: null, recall: null, revoke: true });
        });
        expect(await memory.bindingIsCurrent(receiver, [reference])).toBe(false);
        expect(await memory.recalls(receiver)).toEqual([{ runId, status: "sent", references: [] }]);
        expect(await ask(prompt)).toMatchObject([{ key, scope: "project", value: "48 hours" }]);
      } finally {
        await memory.close();
        await store.close();
        await writer.close();
        await mysql?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
