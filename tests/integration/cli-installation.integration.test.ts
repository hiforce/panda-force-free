import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PandaClient } from "../../src/cli/client.js";
import { writePrivateJson } from "../../src/cli/files.js";
import { CliProfiles } from "../../src/cli/profiles.js";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { cliApiRoute } from "../../src/server/cli/integration/http.js";
import { installLocalCli } from "../../src/server/cli/integration/local-install.js";
import { creationCliEngine } from "../../src/server/harness/application-cli.js";
import type { ApplicationToolEngine } from "../../src/shared/engine/application-tools.js";
import { createRouter } from "../../src/server/http/router.js";

test("remote setup uses just the Panda URL and key; standalone installation reuses a private scoped registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-cli-installation-"));
  const database = openCliCredentialStore(join(root, "cli.sqlite"));
  const credentials = new CliCredentials(database.store);
  const dispatch = createRouter([cliApiRoute(credentials, { execute: async () => ({ configured: true }) })]);
  const server = createServer((req, res) => {
    void dispatch({ req, res, url: new URL(req.url!, "http://localhost") });
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const owner = "installation-owner";
    const localHome = join(root, "local-cli");
    const install = () => installLocalCli(credentials, localHome, base, owner, async () => {});
    await install();
    const local = new CliProfiles(localHome);
    const { apiKey, registration } = await local.credentials("default", "");
    const path = join(localHome, "profiles", "default", "credentials.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const original = await readFile(path);
    await install();
    expect(await readFile(path)).toEqual(original);
    expect(await credentials.list(owner)).toHaveLength(1);
    expect(await credentials.authenticate(registration.clientId, apiKey)).toMatchObject({
      capabilities: ["media:read"],
      projects: ["personal"],
    });

    const remote = new CliProfiles(join(root, "remote-cli"));
    const client = new PandaClient(remote, "demo");
    const nonKey = apiKey.replace(/.$/, apiKey.endsWith("x") ? "y" : "x");
    await expect(client.setup(base, nonKey)).rejects.toMatchObject({ code: "authenticationRequired" });
    expect(await remote.savedRegistration("demo")).toBeUndefined();
    expect(await client.setup(base, apiKey)).toEqual({ connected: true, profile: "demo", server: base, kind: "cli" });
    expect((await client.execute("media.list", {})).data).toEqual({ configured: true });
    const header = { authorization: "Bearer " + apiKey, "x-panda-cli-protocol": "1" };
    expect((await fetch(base + "/api/cli/v1/session", { headers: header })).status).toBe(401);
    expect((await fetch(base + "/api/cli/v1/setup", { headers: { ...header, cookie: "browser=1" } })).status).toBe(401);

    const pendingHome = join(root, "recovered-cli");
    const pending = await credentials.issue(
      owner,
      base,
      {
        name: "Local Panda CLI",
        kind: "cli",
        projects: ["personal"],
        capabilities: ["media:read"],
        expiresInDays: 365,
      },
      async () => {},
      (registration, apiKey) =>
        writePrivateJson(join(pendingHome, ".installation-pending.json"), { registration, apiKey }),
    );
    await installLocalCli(credentials, pendingHome, base, owner, async () => {});
    expect(await new CliProfiles(pendingHome).credentials("default", "")).toEqual({
      registration: pending.registration,
      apiKey: pending.apiKey,
    });
    expect(await credentials.list(owner)).toHaveLength(2);
    await local.logout("default");
    await credentials.revoke(owner, registration.clientId);
    await install();
    await expect(local.credentials("default", "")).rejects.toMatchObject({ code: "authenticationRequired" });
    await expect(client.setup(base, apiKey)).rejects.toMatchObject({ code: "authenticationRequired" });
    expect(await credentials.list(owner)).toHaveLength(2);
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Creation's packaged CLI dispatches a leased operation and never replays an uncertain receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-creation-callback-"));
  const scope = { sessionId: "session", runId: "run" };
  const input = { prompt: "A Greek pottery scene", instructions: "", tools: [] };
  const call = { ...scope, name: "generate", arguments: { prompt: input.prompt }, callId: "request" };
  const result = { success: true, text: "image", images: ["data:image/png;base64,AA=="] };
  let calls = 0;
  const callbacks = {
    signal: AbortSignal.timeout(15000),
    started() {},
    async call(request: unknown) {
      expect(request).toEqual(call);
      calls++;
      return result;
    },
  };
  try {
    const entry = resolve(import.meta.dir, "../../src/cli/main.ts");
    const binary = join(root, "panda.mjs");
    const build = await Bun.build({ entrypoints: [entry], target: "node", minify: true });
    expect(build.success).toBe(true);
    await writeFile(binary, await build.outputs[0]!.text());
    await chmod(binary, 0o700);

    const completed = { ...scope, status: "completed" as const };
    const engine: ApplicationToolEngine = {
      id: "fixture",
      async run(_input, callbacks) {
        const outputs = await Promise.all([callbacks.call(call), callbacks.call(call)]);
        expect(outputs).toEqual([result, result]);
        await expect(callbacks.call({ ...call, name: "different" })).rejects.toMatchObject({ code: "conflict" });
        return completed;
      },
    };
    expect(await creationCliEngine(engine, { command: binary, mode: "cli" }).run(input, callbacks)).toEqual(completed);
    expect(calls).toBe(1);
    const single: ApplicationToolEngine = {
      ...engine,
      async run(_input, callbacks) {
        expect(await callbacks.call(call)).toEqual(result);
        return completed;
      },
    };
    expect(
      await creationCliEngine(single, { command: binary + ".missing", mode: "auto" }).run(input, callbacks),
    ).toEqual(completed);
    expect(
      await creationCliEngine(single, { command: binary + ".missing", mode: "protocol" }).run(input, callbacks),
    ).toEqual(completed);
    await expect(
      creationCliEngine(single, { command: binary + ".missing", mode: "cli" }).run(input, callbacks),
    ).rejects.toMatchObject({ code: "capabilityUnavailable" });
    expect(calls).toBe(3);

    const uncertain = join(root, "uncertain.mjs");
    await writeFile(
      uncertain,
      "#!/usr/bin/env node\nimport {spawn} from 'node:child_process';\n" +
        "const child = spawn(" +
        JSON.stringify(binary) +
        ", process.argv.slice(2), {stdio: ['inherit', 'ignore', 'ignore']});\n" +
        "child.once('exit', () => process.exit(17));\n",
    );
    await chmod(uncertain, 0o700);
    const failed: ApplicationToolEngine = {
      ...engine,
      async run(_input, callbacks) {
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(callbacks.call(call)).rejects.toMatchObject({ code: "capabilityUnavailable" });
        return completed;
      },
    };
    await creationCliEngine(failed, { command: uncertain, mode: "auto" }).run(input, callbacks);
    expect(calls).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
