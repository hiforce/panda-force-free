import {
  memoryFixtureOrganizer,
  memoryFixturePolicy,
  runDueMemory,
  stageCompletedMemory,
} from "../support/memory-organization.js";
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { save } from "../../src/server/harness/records.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import { ProjectMemorySearch } from "../../src/server/project-memory/search-index.js";
import { memorySearchAnalyzer, memorySearchDocuments } from "../../src/server/project-memory/search-documents.js";
import { LocalTextIndex } from "../../src/server/search/providers/local.js";
import { ElasticsearchIndex } from "../../src/server/search/providers/elasticsearch.js";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { conversationKey, namespace, type MemoryConversation } from "../../src/server/project-memory/records.js";
import type { HarnessMetadata } from "../../src/server/harness/ports.js";
import type { IndexReference } from "../../src/server/search/ports.js";
import { elasticsearchFixture } from "../support/elasticsearch-fixture.js";
import { waitFor } from "../support/app-fixture.mjs";

const entry = resolve("src/server/search/worker-entry.ts");

async function seedConversation(
  {
    sql,
    history,
    memory,
    dir,
  }: {
    sql: HarnessMetadata;
    history: JsonlHarnessHistory;
    memory: ProjectMemory;
    dir: string;
  },
  { owner, projectId, createdAt, text }: { owner: string; projectId: string; createdAt: number; text?: string },
): Promise<MemoryConversation> {
  const id = randomUUID();
  const user = {
    id: randomUUID(),
    seq: 1,
    role: "user" as const,
    text: text ?? "",
    runId: randomUUID(),
    runtimeId: "codex",
    model: null,
    attachments: [],
    status: "complete" as const,
    createdAt,
  };
  const historyBytes = text
    ? await history.append(owner, id, 0, [
        { type: "message", seq: 1, message: user },
        {
          type: "message",
          seq: 2,
          message: { ...user, id: randomUUID(), seq: 2, role: "assistant", text: "Acknowledged." },
        },
      ])
    : 0;
  const value: MemoryConversation = {
    id,
    owner,
    projectId,
    revision: 1,
    cwd: dir,
    archivedAt: null,
    historyBytes,
    lastSeq: text ? 2 : 0,
  };
  await sql.transaction(async (tx) => {
    await save(tx, conversationKey(id), "conversation", owner, value);
    if (text) await stageCompletedMemory(tx, memory, value, user);
  });
  return value;
}

for (const storage of ["SQLite", "MySQL"] as const)
  test.skipIf(storage === "MySQL" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    storage + " local and Elasticsearch memory projections are scoped, minimized, repairable and fenced at recall",
    async () => {
      const mysql = storage === "MySQL" ? await isolatedMySQLDatabase("memindex") : undefined;
      if (mysql)
        await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
      const dir = await mkdtemp(join(tmpdir(), "project-memory-index-")),
        localRoot = join(dir, "index"),
        sql = mysql ? new MySQLHarnessMetadata(mysql.sql) : new SQLiteHarnessMetadata(join(dir, "harness.sqlite")),
        history = new JsonlHarnessHistory(join(dir, "history")),
        local = new LocalTextIndex(localRoot, entry),
        es = await elasticsearchFixture(),
        remote = new ElasticsearchIndex(
          new SearchHttp({ id: "test-es", kind: "elasticsearch", url: es.url, prefix: "memory" }),
          randomUUID(),
          local,
        );
      let time = Date.now();
      const memory = new ProjectMemory(
        sql,
        history,
        async () => {},
        undefined,
        () => time,
        undefined,
        memoryFixtureOrganizer,
        {
          local,
          external: "test-es",
          resolveExternal: async () => remote,
        },
      );
      const owner = "actor",
        project = "atlas";
      const text = "Project convention [release]: cache ttl = 24 confidential hours";
      const alternative = "Project convention [release]: cache ttl = 55 independent minutes";

      const conversation = async (owner: string, projectId: string, message?: string) => {
        const value = await seedConversation(
          { sql, history, memory, dir },
          { owner, projectId, createdAt: time, text: message },
        );
        time++;
        return value;
      };

      try {
        for (const [who, where] of [
          [owner, project],
          [owner, "another-project"],
          ["other-owner", project],
        ] as const)
          await memory.configure(who, where, { revision: 0, write: true, recall: true, model: memoryFixturePolicy });
        const source = await conversation(owner, project, text);
        const target = await conversation(owner, project);
        await conversation(owner, "another-project", alternative);
        await conversation("other-owner", project, alternative);
        await runDueMemory(sql, memory);
        memory.start();
        await waitFor(async () => {
          for (const [who, where] of [
            [owner, project],
            [owner, "another-project"],
            ["other-owner", project],
          ] as const) {
            const current = await memory.indexStatus(who, where);
            if (current?.backend !== "elasticsearch" || current.state !== "ready") return false;
          }
          return true;
        });
        const query = "What is the cache ttl for release? do not leak this query";
        const prepared = await memory.prepareRecall(target, query);
        expect(prepared?.hits.size).toBe(1);
        expect(await sql.transaction((tx) => memory.recall(tx, target, query, [], prepared))).toMatchObject([
          { value: "24 confidential hours", sources: [{ conversationId: source.id }] },
        ]);
        expect(await memory.find(owner, "another-project", "cache ttl")).toMatchObject([
          { value: "55 independent minutes" },
        ]);
        expect(await memory.find("other-owner", project, "cache ttl")).toMatchObject([
          { value: "55 independent minutes" },
        ]);
        expect(await memory.find(owner, project, "cache ttl")).toMatchObject([{ value: "24 confidential hours" }]);

        const outbound = JSON.stringify(
          es.calls.filter(
            ({ method, path }) =>
              (method === "PUT" && path.includes("/_doc/")) || (method === "POST" && path.endsWith("/_search")),
          ),
        );
        expect(outbound).not.toContain("confidential");
        expect(outbound).not.toContain("independent");
        expect(outbound).not.toContain("leak");
        expect(outbound).not.toContain(source.id);
        const [authority] = await memory.catalog(owner, project);
        expect(outbound).not.toContain(authority!.version!);
        expect(outbound).toContain("cach ttl");

        es.faults.timedOut = true;
        const fallback = await memory.prepareRecall(target, query);
        expect(fallback?.hits.size).toBe(1);
        expect(es.indexes.size).toBe(3);
        await sql.transaction((tx) =>
          memory.configureSource(tx, source, { revision: 0, write: null, recall: null, revoke: true }),
        );
        expect(await sql.transaction((tx) => memory.recall(tx, target, query, [], prepared))).toEqual([]);
        expect(await memory.find(owner, project, "cache ttl")).toEqual([]);
        expect((await memory.indexStatus(owner, project))?.cleanupPending).toBe(true);

        es.faults.timedOut = false;
        await waitFor(async () => (await memory.indexStatus(owner, project))?.state === "ready");
        time += 65_000;
        await waitFor(async () => !(await memory.indexStatus(owner, project))?.cleanupPending);
        expect(es.indexes.size).toBe(3);
        expect(await memory.find(owner, project, query)).toEqual([]);

        const files = (await readdir(localRoot)).filter((f) => f.endsWith(".json"));
        expect(files).toHaveLength(3);
        // Corrupt all derived copies, leaving the source ledger untouched.
        for (const file of files) {
          expect(await readFile(join(localRoot, file), "utf8")).not.toContain("55 independent minutes");
          await writeFile(join(localRoot, file), "{}");
        }
        expect(await memory.find(owner, "another-project", "cache ttl")).toEqual([]);
        await waitFor(async () => (await memory.find(owner, "another-project", "cache ttl")).length === 1);
        expect(await memory.find(owner, project, "cache ttl")).toEqual([]);
        await memory.close();
        const reopened = new ProjectMemorySearch(
          sql,
          {
            local,
            resolveExternal: async (id) => {
              expect(id).toBe("test-es");
              return remote;
            },
          },
          async () => [],
          () => time,
        );
        try {
          expect(await reopened.status(owner, "another-project")).toMatchObject({
            backend: "local",
            cleanupPending: true,
          });
          await waitFor(async () => {
            time += 8000;
            await reopened.process("elasticsearch");
            await reopened.process("local");
            return !(await reopened.status(owner, "another-project")).cleanupPending;
          }, 8000);
          expect(es.indexes.size).toBe(2);
        } finally {
          await reopened.close();
        }
      } finally {
        await memory.close();
        await local.close();
        await sql.close();
        await mysql?.close();
        await es.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    60000,
  );

const realEndpoint = process.env.PANDA_FORCE_TEST_MEMORY_ELASTICSEARCH;
test.skipIf(!realEndpoint)(
  "isolated Elasticsearch recalls source-backed multilingual project memory and immediately fences withdrawal",
  async () => {
    const endpoint = new URL(realEndpoint!);
    expect(endpoint.hostname).toBe("127.0.0.1");
    const dir = await mkdtemp(join(tmpdir(), "memory-elasticsearch-native-"));
    const sql = new SQLiteHarnessMetadata(join(dir, "harness.sqlite"));
    const history = new JsonlHarnessHistory(join(dir, "history"));
    const local = new LocalTextIndex(join(dir, "index"), entry);
    const http = new SearchHttp({
      id: "memory-native",
      kind: "elasticsearch",
      url: endpoint.origin,
      prefix: "memory_test",
    });
    const remote = new ElasticsearchIndex(http, randomUUID(), local);
    const providers = { local, external: "memory-native", resolveExternal: async () => remote };
    let timeOffset = 0;
    const now = () => Date.now() + timeOffset;
    const memory = new ProjectMemory(
      sql,
      history,
      async () => {},
      undefined,
      now,
      undefined,
      memoryFixtureOrganizer,
      providers,
    );
    const owner = "owner",
      project = "atlas",
      question = "release 发布缓存 unsent-question-marker";
    const scopes = [
      [owner, project],
      [owner, "another-project"],
      ["another-owner", project],
    ] as const;
    const nativeQueries: string[] = [];
    let nativeMatches = 0;
    const query = remote.query.bind(remote);
    remote.query = async (index, text, ...rest) => {
      nativeQueries.push(text);
      const hits = await query(index, text, ...rest);
      nativeMatches += hits.length;
      return hits;
    };

    try {
      for (const [who, where] of scopes)
        await memory.configure(who, where, { revision: 0, write: true, recall: true, model: memoryFixturePolicy });
      const conversation = (actor: string, projectId: string, text?: string) =>
        seedConversation({ sql, history, memory, dir }, { owner: actor, projectId, createdAt: now(), text });
      const source = await conversation(owner, project, "项目约定 [release]: 发布缓存 = 24 hours");
      const target = await conversation(owner, project);
      const otherProject = await conversation(owner, "another-project");
      const otherOwner = await conversation("another-owner", project);
      await runDueMemory(sql, memory);
      memory.start();
      await waitFor(async () => {
        for (const [who, where] of scopes) {
          const status = await memory.indexStatus(who, where);
          if (status?.backend !== "elasticsearch" || status.state !== "ready") return false;
        }
        return true;
      }, 40_000);

      await waitFor(async () => {
        const results = await memory.find(owner, project, question);
        return results.length && nativeMatches > 0;
      }, 10_000);
      const prepared = await memory.prepareRecall(target, question);
      expect(prepared?.hits.size).toBe(1);
      expect(await sql.transaction((tx) => memory.recall(tx, target, question, [], prepared))).toMatchObject([
        { key: "发布缓存", value: "24 hours", sources: [{ conversationId: source.id }] },
      ]);
      expect(new Set(nativeQueries)).toEqual(new Set(["发布缓存"]));
      const relevantQueries = nativeQueries.length;
      expect((await memory.prepareRecall(otherProject, question))?.hits.size).toBe(0);
      expect((await memory.prepareRecall(otherOwner, question))?.hits.size).toBe(0);
      expect((await memory.prepareRecall(target, "unrelated-xyz-987"))?.hits.size).toBe(0);
      expect(nativeQueries).toHaveLength(relevantQueries);
      const [durable] = await sql.list("memory-index:elasticsearch", namespace(owner, project));
      const resource: IndexReference = JSON.parse(durable!.data).published.ref;
      // Stop the projection workers so the remote candidate is provably unchanged when the source is withdrawn.
      await memory.close();
      await sql.transaction((tx) =>
        memory.configureSource(tx, source, { revision: 0, write: null, recall: null, revoke: true }),
      );
      expect(
        await remote.query(resource, "发布缓存", memorySearchAnalyzer, 10, AbortSignal.timeout(5000)),
      ).toHaveLength(1);
      expect(await sql.transaction((tx) => memory.recall(tx, target, question, [], prepared))).toEqual([]);

      const reopened = new ProjectMemorySearch(
        sql,
        { local, resolveExternal: async () => remote },
        async (actor, where, salt) => memorySearchDocuments(await memory.catalog(actor, where), salt),
        now,
      );
      try {
        expect(await reopened.status(owner, project)).toMatchObject({ backend: "local", cleanupPending: true });
        await waitFor(async () => {
          timeOffset += 4000;
          await reopened.process("local");
          await reopened.process("elasticsearch");
          const status = await reopened.status(owner, project);
          return status.state === "ready" && !status.cleanupPending;
        }, 8000);
        await expect(
          remote.query(resource, "发布缓存", memorySearchAnalyzer, 10, AbortSignal.timeout(5000)),
        ).rejects.toMatchObject({ reason: "missing" });
      } finally {
        await reopened.close();
      }
    } finally {
      await memory.close();
      await local.close();
      await sql.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  75_000,
);

test("an in-flight rebuild cannot publish a generation superseded by a source mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-index-fence-")),
    sql = new SQLiteHarnessMetadata(join(dir, "memory.sqlite")),
    local = new LocalTextIndex(join(dir, "index"), entry);
  const created = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let held = true;
  const build = local.build.bind(local);
  local.build = async (...args) => {
    if (held) {
      held = false;
      created.resolve();
      await release.promise;
    }
    return build(...args);
  };
  const index = new ProjectMemorySearch(sql, { local }, async () => []);
  try {
    await sql.transaction((tx) => index.dirty(tx, "owner", "project"));
    const attempt = index.process("local");
    await created.promise;
    try {
      await sql.transaction((tx) => index.dirty(tx, "owner", "project"));
    } finally {
      release.resolve();
    }
    await attempt;
    expect(await index.status("owner", "project")).toMatchObject({ state: "pending", cleanupPending: true });
    await index.process("local");
    expect(await index.status("owner", "project")).toMatchObject({ state: "ready" });
  } finally {
    await index.close();
    await local.close();
    await sql.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
