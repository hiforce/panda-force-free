import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { createRouter } from "../../src/server/http/router.js";
import { cliApiRoute } from "../../src/server/cli/integration/http.js";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { cliContentCommands } from "../../src/server/cli/integration/content.js";
import { CliProfiles } from "../../src/cli/profiles.js";
import { PandaClient } from "../../src/cli/client.js";
import { runPandaCli } from "../../src/cli/application.js";
import { servePandaMcp } from "../../src/cli/mcp.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { Database } from "bun:sqlite";

test("registered clients share real file/knowledge commands; missing keys, scope escape and revocation return no content", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-cli-http-")),
    files = await projectFileApiFixture(),
    db = openCliCredentialStore(join(root, "auth.sqlite")),
    credentials = new CliCredentials(db.store),
    profiles = new CliProfiles(join(root, "profiles"));
  const knowledge = createKnowledgeFeature({
    stateRoot: join(root, "knowledge"),
    content: new FileDocumentKnowledgeContent(files.application().projectContent),
    owner: () => "owner-a",
    available: () => true,
    profile: async () => ({ id: "fixture", engineId: "codex", model: "fixture", activeTimeoutMs: 180000 }),
    engine: () => {
      throw new Error("No model calls in this fixture");
    },
    report() {},
  });
  let block: Promise<void> | null = null,
    release: (() => void) | null = null,
    entered: (() => void) | null = null;
  const commands = cliContentCommands({
      authorize: async (_owner, project) => {
        if (project !== "project-1") throw new Error("Scope escaped");
      },
      documents: async () => files.application(),
      knowledge: knowledge.service,
      records: knowledge.records,
      search: async () => ({ hits: [] }),
      searchStatus: async () => ({ state: "idle", ready: false }),
    }),
    route = cliApiRoute(credentials, {
      execute: async (...args) => {
        if (block) {
          entered?.();
          await block;
        }
        return commands.execute(...args);
      },
    }),
    dispatch = createRouter([route]),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    const created = await files.application().navigation.create("operator:test-user", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Private CLI source",
        locale: "en",
      }),
      documentId = created.operation.documentId;
    const issue = (kind: string, capabilities: string[]) =>
      credentials.issue(
        "owner-a",
        base,
        { name: kind, kind, projects: ["project-1"], capabilities, expiresInDays: 1 },
        async () => {},
      );
    const codex = await issue("codex", ["content:read", "search:read", "knowledge:read", "knowledge:write"]),
      claude = await issue("claude", ["content:read"]);
    for (const [profile, record] of [
      ["codex", codex],
      ["claude", claude],
    ] as const) {
      await profiles.register(profile, record.registration);
      await profiles.login(profile, record.apiKey);
    }
    const noKey = await fetch(base + "/api/cli/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: 1, command: "documents.read", args: { project: "project-1", id: documentId } }),
    });
    expect(noKey.status).toBe(401);
    expect(await noKey.text()).not.toContain("Private CLI source");
    const client = new PandaClient(profiles, "codex");
    const historyDb = new Database(join(root, "knowledge", "data", "knowledge.sqlite"), {
      readwrite: true,
      create: false,
    });
    try {
      historyDb
        .transaction(() => {
          for (let i = 0; i < 80; i++) {
            const id = "history-" + String(i).padStart(3, "0");
            historyDb
              .query(
                "INSERT INTO knowledge_tasks(id,owner,project,title,signature,inputDigest,dialogueDigest,state,failure,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'failed','interrupted',1000,1001)",
              )
              .run(id, "owner-a", "project-1", id, id, "a".repeat(64), "b".repeat(64));
          }
        })
        .immediate();
    } finally {
      historyDb.close();
    }
    const firstHistory = await client.execute("knowledge.list", { project: "project-1" });
    expect(firstHistory.data.tasks).toHaveLength(50);
    expect(typeof firstHistory.data.nextCursor).toBe("string");
    const secondHistory = await client.execute("knowledge.list", {
      project: "project-1",
      cursor: firstHistory.data.nextCursor,
    });
    expect(secondHistory.data.tasks).toHaveLength(30);
    expect(secondHistory.data.nextCursor).toBeNull();
    expect(new Set([...firstHistory.data.tasks, ...secondHistory.data.tasks].map((t) => t.id)).size).toBe(80);
    await expect(
      new PandaClient(profiles, "claude").execute("knowledge.list", {
        project: "project-1",
        cursor: firstHistory.data.nextCursor,
      }),
    ).rejects.toThrow("forbidden");
    await expect(client.execute("knowledge.list", { project: "project-1", cursor: "invalid" })).rejects.toThrow(
      "invalidInput",
    );
    expect(
      (await client.execute("documents.list", { project: "project-1" })).data.documents.some(
        (d: { id: string }) => d.id === documentId,
      ),
    ).toBe(true);
    const read = await new PandaClient(profiles, "claude").execute("documents.read", {
      project: "project-1",
      id: documentId,
    });
    expect(read.data.document.title).toBe("Private CLI source");
    await expect(
      new PandaClient(profiles, "claude").execute("documents.read", {
        project: "project-1",
        id: randomUUID(),
      }),
    ).rejects.toThrow("notFound");
    await expect(client.execute("documents.read", { project: "elsewhere", id: documentId })).rejects.toThrow(
      "forbidden",
    );
    await expect(
      new PandaClient(profiles, "claude").execute("knowledge.create", {
        project: "project-1",
        id: randomUUID(),
        ids: [documentId],
        purpose: "Denied",
      }),
    ).rejects.toThrow("forbidden");
    const operation = randomUUID(),
      task = await client.execute("knowledge.create", {
        project: "project-1",
        id: operation,
        ids: [documentId],
        purpose: "Explain the saved source",
      }),
      repeated = await client.execute("knowledge.create", {
        project: "project-1",
        id: operation,
        ids: [documentId],
        purpose: "Explain the saved source",
      });
    expect(task.data.task.id).toBe(repeated.data.task.id);
    expect((await client.execute("knowledge.read", { project: "project-1", id: task.data.task.id })).data.purpose).toBe(
      "Explain the saved source",
    );
    await expect(client.execute("knowledge.previous", { project: "project-1", id: task.data.task.id })).rejects.toThrow(
      "notFound",
    );
    await expect(
      new PandaClient(profiles, "claude").execute("knowledge.previous", {
        project: "project-1",
        id: task.data.task.id,
      }),
    ).rejects.toThrow("forbidden");
    let output = "",
      error = "";
    const io = {
      input: Readable.from([]),
      output: new Writable({
        write(c, _e, cb) {
          output += c;
          cb();
        },
      }),
      error: new Writable({
        write(c, _e, cb) {
          error += c;
          cb();
        },
      }),
    };
    expect(
      await runPandaCli(["documents", "list", "--project", "project-1", "--profile", "codex", "--json"], io, profiles),
    ).toBe(0);
    expect(JSON.parse(output).data.total).toBeGreaterThan(0);
    expect(error).toBe("");
    expect(output).not.toContain(codex.apiKey);
    output = "";
    error = "";
    expect(
      await runPandaCli(
        [
          "knowledge",
          "approve",
          "--project",
          "project-1",
          "--id",
          task.data.task.id,
          "--revision",
          "1",
          "--previous-state",
          "a".repeat(64),
          "--profile",
          "codex",
          "--json",
        ],
        io,
        profiles,
      ),
    ).toBe(4);
    expect(error).toContain("forbidden");
    expect(output).toBe("");
    let mcp = "";
    await servePandaMcp(
      client,
      Readable.from(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "panda_documents_read", arguments: { project: "project-1", id: documentId } },
          },
        ].map((x) => JSON.stringify(x) + "\n"),
      ),
      new Writable({
        write(c, _e, cb) {
          mcp += c;
          cb();
        },
      }),
    );
    expect(mcp).toContain("Private CLI source");
    expect(mcp).not.toContain(codex.apiKey);
    const credentialPath = join(root, "profiles", "profiles", "codex", "credentials.json");
    expect((await readFile(credentialPath, "utf8")).includes(codex.apiKey)).toBe(true);
    await chmod(credentialPath, 0o644);
    await expect(client.request("session")).rejects.toThrow("authenticationRequired");
    await chmod(credentialPath, 0o600);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    entered = ready;
    block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = client.execute("documents.read", { project: "project-1", id: documentId });
    await started;
    await credentials.revoke("owner-a", codex.registration.clientId);
    release!();
    await expect(pending).rejects.toThrow("authenticationRequired");
    await expect(client.request("session")).rejects.toThrow("authenticationRequired");
    await profiles.logout("claude");
    await expect(new PandaClient(profiles, "claude").request("session")).rejects.toThrow("authenticationRequired");
  } finally {
    release?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await knowledge.close();
    db.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
