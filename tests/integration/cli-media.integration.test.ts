import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { runPandaCli } from "../../src/cli/application.js";
import { PandaClient } from "../../src/cli/client.js";
import { servePandaMcp } from "../../src/cli/mcp.js";
import { CliProfiles } from "../../src/cli/profiles.js";
import type { CliCapability } from "../../src/shared/cli/contracts.js";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { cliApiRoute } from "../../src/server/cli/integration/http.js";
import { executeCliMedia } from "../../src/server/cli/integration/media.js";
import { CreationMediaExecutors } from "../../src/server/creation/integration/media-executors/service.js";
import { createRouter } from "../../src/server/http/router.js";

function writer(values: string[]) {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      values.push(chunk.toString());
      done();
    },
  });
}

test("Panda CLI media commands use the personal grant, worker authorization, and stdin credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-cli-media-"));
  const database = openCliCredentialStore(join(root, "cli.sqlite"));
  const profiles = new CliProfiles(join(root, "profiles"));
  const credentials = new CliCredentials(database.store);
  const providerKey = "controlled-provider-key";
  const baseUrl = "https://media-provider.invalid/v1";
  let verifiedConnections = 0;
  const worker = new CreationMediaExecutors(
    join(root, "worker"),
    {
      PANDA_FORCE_MEDIA_EXECUTOR_ENDPOINTS: JSON.stringify({ "grok-image": [baseUrl] }),
    },
    (async (input, init) => {
      verifiedConnections++;
      expect(String(input)).toStartWith(baseUrl + "/image-generation-models/");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + providerKey);
      return Response.json({ id: "grok-imagine-image-2.0" });
    }) as typeof fetch,
  );
  const approved = { id: "cli-fixture", revision: 1, fingerprint: "a".repeat(64) };
  let approvedCount = 0;
  const service = Object.assign(worker, {
    cliCatalog: async () => [
      {
        ...approved,
        name: "Fixture CLI",
        kind: "image" as const,
        sha256: "b".repeat(64),
        version: "1.0.0",
        registered: approvedCount > 0,
      },
    ],
    cliInstructions: async () => ({ usage: "Submit, query and download.", install: "Install the reviewed CLI." }),
    registerCli: async (...args: [string, number, string]) => {
      expect(args.slice(0, 3)).toEqual([approved.id, approved.revision, approved.fingerprint]);
      approvedCount++;
    },
  });
  const route = cliApiRoute(credentials, {
    execute: (owner, command, args, signal) =>
      executeCliMedia({ service, administrator: (owner) => owner === "owner-a" }, owner, command, args, signal),
  });
  const dispatch = createRouter([route]);
  const server = createServer((req, res) => {
    void dispatch({ req, res, url: new URL(req.url!, "http://localhost") });
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const issue = async (profile: string, owner: string, project: string, capabilities: CliCapability[]) => {
      const record = await credentials.issue(
        owner,
        base,
        {
          name: profile,
          kind: "cli",
          projects: [project],
          capabilities,
          expiresInDays: 1,
        },
        async () => {},
      );
      await profiles.register(profile, record.registration);
      await profiles.login(profile, record.apiKey);
      return new PandaClient(profiles, profile);
    };
    const capabilities = ["media:read", "media:connect", "media:admin"] as const;
    const operator = await issue("operator", "owner-a", "personal", [...capabilities]);
    const member = await issue("member", "owner-b", "personal", [...capabilities]);
    const projectOnly = await issue("project-only", "owner-a", "project-a", [...capabilities]);
    const readOnly = await issue("read-only", "owner-a", "personal", ["media:read"]);
    const id = randomUUID();
    const registeredKey = async (words: string[], input = "") => {
      const out: string[] = [],
        errors: string[] = [];
      const status = await runPandaCli(
        [...words, "--profile", "operator", "--json"],
        {
          input: Readable.from([input]),
          output: writer(out),
          error: writer(errors),
        },
        profiles,
      );
      return { status, output: out.join(""), error: errors.join("") };
    };
    const flags = ["media", "connect", "--id", id, "--preset", "grok-image", "--revision", "0", "--base-url", baseUrl];
    const refused = await registeredKey([...flags, "--api-key", providerKey]);
    expect(refused).toMatchObject({ status: 2, output: "" });
    expect(refused.error).not.toContain(providerKey);
    expect(verifiedConnections).toBe(0);
    const linked = await registeredKey([...flags, "--api-key-stdin"], providerKey + "\n");
    expect(linked.status).toBe(0);
    expect(JSON.parse(linked.output).data).toMatchObject({ id, status: "connected", revision: 1 });
    expect(linked.output).not.toContain(providerKey);
    expect((await registeredKey([...flags, "--api-key-stdin"], providerKey + "\n")).status).toBe(0);
    expect(verifiedConnections).toBe(1);
    const list = (await operator.execute("media.list", {})).data;
    expect(list.executors).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(providerKey);
    expect(JSON.stringify(list)).not.toContain(baseUrl);
    expect((await member.execute("media.list", {})).data.executors).toEqual([]);
    await expect(member.execute("media.remove", { id, revision: 1 })).rejects.toMatchObject({ code: "notFound" });
    await expect(readOnly.execute("media.remove", { id, revision: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(projectOnly.execute("media.list", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(member.execute("media.cli.list", {})).rejects.toMatchObject({ code: "forbidden" });
    expect((await operator.execute("media.cli.list", {})).data.packages[0]).toMatchObject(approved);
    expect((await operator.execute("media.cli.instructions", { id: approved.id, revision: 1 })).data.install).toContain(
      "reviewed CLI",
    );
    const registration = [
      "media",
      "cli",
      "register",
      "--id",
      approved.id,
      "--revision",
      "1",
      "--fingerprint",
      approved.fingerprint,
    ];
    expect(JSON.parse((await registeredKey(registration)).output).data).toEqual({ registered: true });
    expect(approvedCount).toBe(1);
    const mcpOutput: string[] = [];
    const messages = [
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {} } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "panda_media_cli_register", arguments: approved } },
    ];
    await servePandaMcp(
      operator,
      Readable.from(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n")),
      writer(mcpOutput),
    );
    const protocol = mcpOutput
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(protocol.find(({ id }) => id === 2).result.tools).toEqual([]);
    expect(protocol.find(({ id }) => id === 3).error.code).toBe(-32602);
    expect(approvedCount).toBe(1);
    const credentialId = randomUUID();
    const sharedExecutor = randomUUID();
    const createCredential = [
      "media",
      "credentials",
      "save",
      "--id",
      credentialId,
      "--revision",
      "0",
      "--target",
      "xai",
      "--name",
      "Studio",
      "--base-url",
      baseUrl,
      "--api-key-stdin",
    ];
    const stored = await registeredKey(createCredential, providerKey + "\n");
    expect(stored.status).toBe(0);
    expect(stored.output).not.toContain(providerKey);
    const shared = await registeredKey([
      "media",
      "connect",
      "--id",
      sharedExecutor,
      "--revision",
      "0",
      "--preset",
      "grok-image",
      "--credential-id",
      credentialId,
    ]);
    expect(shared.status).toBe(0);
    expect(JSON.parse(shared.output).data).toMatchObject({ id: sharedExecutor, credentialId });
    expect((await member.execute("media.list", {})).data.credentials).toEqual([]);
    await expect(readOnly.execute("media.credentials.remove", { id: credentialId, revision: 1 })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect((await operator.execute("media.credentials.remove", { id: credentialId, revision: 1 })).data).toEqual({
      removed: true,
    });
    expect((await operator.execute("media.remove", { id, revision: 1 })).data).toEqual({ removed: true });
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
