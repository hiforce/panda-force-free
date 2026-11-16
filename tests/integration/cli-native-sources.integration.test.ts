import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { nativeKnowledgeFixture } from "../support/native-knowledge-fixture.js";
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

test("registered Codex and Claude clients read native originals and submit explicit knowledge kinds without hidden inference", async () => {
  const f = await nativeKnowledgeFixture(),
    auth = openCliCredentialStore(join(f.root, "cli.sqlite")),
    credentials = new CliCredentials(auth.store),
    profiles = new CliProfiles(join(f.root, "client-profiles")),
    feature = createKnowledgeFeature({
      stateRoot: f.root,
      content: f.content,
      documents: async () => f.app.projectContent,
      originals: async () => f.app.originals,
      available: () => true,
      profile: async () => f.input.profile,
      engine: () => {
        throw Error("No model worker was started");
      },
      owner: () => f.scope.owner,
      report: () => {},
    }),
    commands = cliContentCommands({
      authorize: async (_owner, project) => f.app.projectContent.authorize(project),
      documents: async () => f.app,
      originals: async () => f.app.originals,
      knowledge: feature.service,
      records: feature.records,
      search: async () => {
        throw Error("No search requested");
      },
      searchStatus: async () => ({}),
    }),
    dispatch = createRouter([cliApiRoute(credentials, commands)]),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) });
    });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    f.complete();
    const anonymous = await fetch(base + "/api/cli/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json", "x-panda-cli-protocol": "1" },
      body: JSON.stringify({
        schema: 1,
        command: "sources.list",
        args: { project: "project-1", contentKinds: ["web"] },
      }),
    });
    expect(anonymous.status).toBe(401);
    for (const kind of ["codex", "claude"] as const) {
      const issued = await credentials.issue(
        f.scope.owner,
        base,
        {
          name: kind,
          kind,
          projects: ["project-1"],
          capabilities: ["content:read", "knowledge:records:read", "knowledge:write"],
          expiresInDays: 1,
        },
        async () => {},
      );
      await profiles.register(kind, issued.registration);
      await profiles.login(kind, issued.apiKey);
      const client = new PandaClient(profiles, kind),
        list = (await client.execute("sources.list", { project: "project-1", contentKinds: ["web"] })).data;
      expect(list.sources.map((source: { id: string }) => source.id)).toEqual([f.saved.asset.id]);
      expect(list.sources[0].kind).toBe("web");
      expect(list.nextOffset).toBeNull();
      expect(list.head).toMatch(/^[a-f0-9]{64}$/);
      const legacySources = (await client.execute("sources.list", { project: "project-1" })).data.sources;
      expect(legacySources.every((source: { kind: string }) => source.kind === "document")).toBe(true);
      expect(legacySources.some((source: { id: string }) => source.id === f.saved.asset.id)).toBe(false);
      const args = {
          project: "project-1",
          id: f.saved.asset.id,
          contentKinds: ["web"],
          sourceVersion: f.saved.asset.version,
        },
        read = (await client.execute("sources.read", args)).data.source;
      expect(read.text).toBe("Native evidence\nVerified original content");
      expect(read.url).toContain("assetVersion=" + f.saved.asset.version);
      expect(JSON.stringify(read)).not.toContain("Hidden script");
      await expect(client.execute("sources.read", { ...args, sourceVersion: "changed" })).rejects.toThrow("conflict");
      await expect(client.execute("sources.read", { ...args, project: "other" })).rejects.toThrow("forbidden");
      await expect(
        client.execute("sources.list", { project: "project-1", contentKinds: ["web", "web"] }),
      ).rejects.toThrow("invalidInput");
      await expect(client.execute("sources.list", { project: "project-1", head: "b".repeat(64) })).rejects.toThrow(
        "indexChanged",
      );
      const output: string[] = [],
        errors: string[] = [],
        code = await runPandaCli(
          [
            "sources",
            "read",
            "--project",
            "project-1",
            "--id",
            f.saved.asset.id,
            "--content-kinds",
            "web",
            "--source-version",
            f.saved.asset.version,
            "--profile",
            kind,
            "--json",
          ],
          {
            input: Readable.from([]),
            output: new Writable({
              write(chunk, _encoding, done) {
                output.push(chunk.toString());
                done();
              },
            }),
            error: new Writable({
              write(chunk, _encoding, done) {
                errors.push(chunk.toString());
                done();
              },
            }),
          },
          profiles,
        );
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(JSON.parse(output.join("")).data.source).toEqual(read);
      const operation = randomUUID(),
        created = (
          await client.execute("knowledge.create", {
            project: "project-1",
            id: operation,
            ids: [f.saved.asset.id],
            contentKinds: ["web"],
            purpose: "Explicit native source task " + kind,
          })
        ).data.task,
        stored = await f.files.input(f.ledger.get(f.scope.owner, created.id).inputDigest);
      expect(stored.scope.contentKinds).toEqual(["web"]);
      expect(stored.sources[0]!.binding).toEqual(f.input.sources[0]!.binding);
      expect(created.state).toBe("queued");
      await expect(
        client.execute("knowledge.approve", { project: "project-1", id: created.id, revision: 0 }),
      ).rejects.toThrow("forbidden");
      const mcp: string[] = [];
      await servePandaMcp(
        client,
        Readable.from([
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: kind, version: "test" } },
          }) + "\n",
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "panda_sources_read", arguments: args },
          }) + "\n",
        ]),
        new Writable({
          write(chunk, _encoding, done) {
            mcp.push(chunk.toString());
            done();
          },
        }),
      );
      const messages = mcp
          .join("")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        tools = messages.find((item) => item.id === 2).result.tools;
      expect(tools.some((tool: { name: string }) => tool.name === "panda_sources_read")).toBe(true);
      expect(tools.some((tool: { name: string }) => tool.name === "panda_knowledge_approve")).toBe(false);
      expect(JSON.parse(messages.find((item) => item.id === 3).result.content[0].text).data.source).toEqual(read);
      expect(mcp.join("")).not.toContain(issued.apiKey);
      await credentials.revoke(f.scope.owner, issued.registration.clientId);
      await expect(client.execute("sources.read", args)).rejects.toThrow("authenticationRequired");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await feature.close();
    auth.close();
    await f.close();
  }
}, 60000);
