import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { cliContentCommands } from "../../src/server/cli/integration/content.js";
import { cliApiRoute } from "../../src/server/cli/integration/http.js";
import { createRouter } from "../../src/server/http/router.js";
import { CliProfiles } from "../../src/cli/profiles.js";
import { PandaClient } from "../../src/cli/client.js";
import { runPandaCli } from "../../src/cli/application.js";
import { servePandaMcp } from "../../src/cli/mcp.js";
import { SearchError } from "../../src/shared/search/contracts.js";

test("approved records, legacy tasks and metered search have independent grants across HTTP, CLI and MCP", async () => {
  const f = await knowledgeCatalogFixture(),
    auth = openCliCredentialStore(join(f.root, "cli.sqlite")),
    credentials = new CliCredentials(auth.store),
    profiles = new CliProfiles(join(f.root, "clients")),
    feature = createKnowledgeFeature({
      stateRoot: f.root,
      content: f.content,
      documents: async () => f.documents.application().projectContent,
      available: () => false,
      profile: async () => {
        throw new Error("No generation requested");
      },
      engine: () => {
        throw new Error("No model requested");
      },
      owner: () => f.owner,
      report: () => {},
    });
  f.complete();
  let queryCalls = 0,
    embeddingCalls = 0,
    statusCalls = 0,
    block: Promise<void> | null = null,
    entered: (() => void) | null = null,
    recordError: unknown;
  const commands = cliContentCommands({
      authorize: async (_owner, project) => {
        if (project !== "project-1") throw new Error("Scope escaped");
      },
      documents: async () => f.documents.application(),
      knowledge: feature.service,
      records: {
        detail: async (...args) => {
          if (block) {
            entered?.();
            await block;
          }
          try {
            return await feature.records.detail(...args);
          } catch (error) {
            recordError = error;
            throw error;
          }
        },
      },
      search: async (_owner, input) => {
        queryCalls++;
        if (["configuration", "notReady", "indexChanged"].includes(String(input.query)))
          throw new SearchError(input.query as "configuration" | "notReady" | "indexChanged", 409);
        if (input.mode !== undefined && input.mode !== "text") embeddingCalls++;
        return { hits: [], state: "ready", nextCursor: null, failure: null, mode: input.mode ?? "text" };
      },
      searchStatus: async () => {
        statusCalls++;
        return { state: "ready", ready: true };
      },
    }),
    dispatch = createRouter([cliApiRoute(credentials, commands)]),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) });
    });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  type Issued = Awaited<ReturnType<CliCredentials["issue"]>>;
  const issue = (owner: string, capabilities: string[]) =>
    credentials.issue(
      owner,
      base,
      { name: owner, kind: "claude", projects: ["project-1"], capabilities, expiresInDays: 1 },
      async () => {},
    );
  const post = (record: Issued, command: string, args: unknown) =>
    fetch(base + "/api/cli/v1/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + record.apiKey,
        "x-panda-client-id": record.registration.clientId,
        "x-panda-cli-protocol": "1",
      },
      body: JSON.stringify({ schema: 1, command, args }),
    });
  try {
    const legacy = await issue(f.owner, ["knowledge:read", "search:read"]),
      reader = await issue("bob", ["knowledge:records:read"]),
      searcher = await issue("bob", ["knowledge:records:read", "search:read"]);
    for (const [name, record] of [
      ["legacy", legacy],
      ["reader", reader],
      ["searcher", searcher],
    ] as const) {
      await profiles.register(name, record.registration);
      await profiles.login(name, record.apiKey);
    }
    const old = new PandaClient(profiles, "legacy"),
      read = new PandaClient(profiles, "reader"),
      both = new PandaClient(profiles, "searcher"),
      recordArgs = { project: "project-1", id: f.record.id };
    expect((await old.execute("knowledge.read", { project: "project-1", id: f.admission.taskId })).data.purpose).toBe(
      f.input.purpose,
    );
    await expect(old.execute("knowledge.records.read", recordArgs)).rejects.toThrow("forbidden");
    await expect(read.execute("knowledge.read", { project: "project-1", id: f.admission.taskId })).rejects.toThrow(
      "forbidden",
    );
    const value = (await read.execute("knowledge.records.read", recordArgs)).data;
    expect(value.record.version).toBe(f.record.version);
    expect(value.receipt).toEqual(f.admission.receipt);
    expect(value.record.draft.claims[0].evidence[0].quote).toBe("durable");
    expect(Object.keys(value).sort()).toEqual(["receipt", "record"]);
    expect(JSON.stringify(value)).not.toContain(f.admission.inputDigest);
    await expect(read.execute("knowledge.records.read", { ...recordArgs, project: "elsewhere" })).rejects.toThrow(
      "forbidden",
    );
    expect((await old.execute("search.query", { project: "project-1", query: "storage" })).data.mode).toBe("text");
    for (const mode of ["semantic", "hybrid"]) {
      await expect(old.execute("search.query", { project: "project-1", query: "storage", mode })).rejects.toThrow(
        "forbidden",
      );
      await expect(read.execute("search.query", { project: "project-1", query: "storage", mode })).rejects.toThrow(
        "forbidden",
      );
    }
    expect(queryCalls).toBe(1);
    expect(embeddingCalls).toBe(0);
    for (const mode of ["semantic", "hybrid"])
      expect((await both.execute("search.query", { project: "project-1", query: "storage", mode })).data.mode).toBe(
        mode,
      );
    expect(embeddingCalls).toBe(2);
    for (let i = 0; i < 3; i++) await both.execute("search.status", { project: "project-1" });
    expect(statusCalls).toBe(3);
    expect(queryCalls).toBe(3);
    expect(embeddingCalls).toBe(2);
    for (const args of [
      { project: "project-1", query: "storage", mode: ["semantic"] },
      { project: "project-1", query: "storage", mode: "automatic" },
      { project: "project-1", query: "storage", source: "other" },
    ])
      expect((await post(searcher, "search.query", args)).status).toBe(400);
    expect(queryCalls).toBe(3);
    for (const code of ["configuration", "notReady", "indexChanged"])
      await expect(
        both.execute("search.query", { project: "project-1", query: code, mode: "semantic" }),
      ).rejects.toThrow(code);
    expect(embeddingCalls).toBe(2);
    let output = "",
      error = "";
    const writable = (append: (value: string) => void) =>
      new Writable({
        write(c, _encoding, done) {
          append(String(c));
          done();
        },
      });
    expect(
      await runPandaCli(
        [
          "knowledge",
          "records",
          "read",
          "--project",
          "project-1",
          "--id",
          f.record.id,
          "--profile",
          "reader",
          "--json",
        ],
        {
          input: Readable.from([]),
          output: writable((v) => {
            output += v;
          }),
          error: writable((v) => {
            error += v;
          }),
        },
        profiles,
      ),
    ).toBe(0);
    expect(JSON.parse(output).data.record.id).toBe(f.record.id);
    expect(error).toBe("");
    const mcp = async (client: PandaClient) => {
      let out = "";
      await servePandaMcp(
        client,
        Readable.from(
          [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "fixture", version: "1" },
              },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "panda_knowledge_records_read", arguments: recordArgs },
            },
          ].map((v) => JSON.stringify(v) + "\n"),
        ),
        writable((v) => {
          out += v;
        }),
      );
      expect(out).not.toContain(reader.apiKey);
      return out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };
    const oldTools = await mcp(old),
      newTools = await mcp(both);
    expect(oldTools[1].result.tools.some((t: { name: string }) => t.name === "panda_knowledge_records_read")).toBe(
      false,
    );
    expect(
      oldTools[1].result.tools.find((t: { name: string }) => t.name === "panda_search_query").inputSchema.properties
        .mode.enum,
    ).toEqual(["text"]);
    expect(oldTools[2].result.isError).toBe(true);
    expect(
      newTools[1].result.tools.find((t: { name: string }) => t.name === "panda_search_query").inputSchema.properties
        .mode.enum,
    ).toEqual(["text", "semantic", "hybrid"]);
    expect(JSON.parse(newTools[2].result.content[0].text).data.record.id).toBe(f.record.id);
    let release!: () => void, started!: () => void;
    block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    entered = started;
    const pending = post(searcher, "knowledge.records.read", recordArgs);
    await waiting;
    await credentials.revoke("bob", searcher.registration.clientId);
    release();
    const denied = await pending;
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(f.record.draft.summary);
    block = null;
    const app = f.documents.application(),
      sourceId = f.input.scope.ids[0]!,
      opened = await app.queries.editor("project-1", sourceId),
      changed = await app.editor.autosave(f.owner, "project-1", sourceId, {
        operationId: randomUUID(),
        version: opened.draft.version,
        baseRevisionId: opened.draft.baseRevisionId,
        working: { ...opened.working, title: opened.working.title + " updated" },
      });
    await app.editor.save(f.owner, "project-1", sourceId, {
      operationId: randomUUID(),
      revisionId: opened.saved.revision.id,
      draftVersion: changed.version,
    });
    const stale = await post(reader, "knowledge.records.read", recordArgs);
    if (![404, 409].includes(stale.status))
      throw new Error(
        "Unexpected stale record response: " +
          stale.status +
          " / " +
          (recordError instanceof Error ? recordError.stack : String(recordError)),
      );
    expect([404, 409]).toContain(stale.status);
    expect(await stale.text()).not.toContain(f.record.draft.summary);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await feature.close();
    auth.close();
    await f.close();
  }
}, 20000);
