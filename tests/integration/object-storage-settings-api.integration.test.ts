import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRouter } from "../../src/server/http/router.js";
import { originalStorageRoutes } from "../../src/server/object-storage/routes.js";
import { OriginalStorageConfiguration } from "../../src/server/object-storage/configuration.js";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-storage-api-"));
  let authenticated = true;
  const configuration = new OriginalStorageConfiguration(new PrivateStorageFiles(join(root, "private"))),
    dispatch = createRouter(
      originalStorageRoutes({
        configuration,
        administrator: (context) => context.req.headers["x-fixture-role"] === "administrator",
        authenticationConfigured: () => authenticated,
      }),
    ),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) })
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        })
        .catch(() => res.writeHead(500).end());
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned HTTP port");
  const base = "http://127.0.0.1:" + address.port;
  return {
    root,
    configuration,
    base,
    authentication: (value: boolean) => {
      authenticated = value;
    },
    request: (path = "", body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + "/api/system/storage" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("storage settings require login and installation administration before reading or preparing any state", async () => {
  const f = await fixture();
  try {
    for (const role of ["member", "project-owner", ""]) {
      const denied = await f.request("", undefined, { "x-fixture-role": role });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error).toMatchObject({
        code: "storageAdministratorRequired",
        messageId: "storage.errorAdministrator",
      });
    }
    f.authentication(false);
    const noLogin = await f.request("", undefined, { "x-fixture-role": "administrator" });
    expect(noLogin.status).toBe(403);
    expect((await noLogin.json()).error.code).toBe("storageAuthenticationRequired");
    expect(await readdir(f.root)).toEqual([]);
    f.authentication(true);
    const current = await f.request("", undefined, { "x-fixture-role": "administrator" });
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("private, no-store");
    expect((await current.json()).mode).toBe("local");
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("real HTTP settings saves reject cross-site writes, return no keys, coalesce retries and report durable outcomes", async () => {
  const f = await fixture();
  try {
    const input = {
      action: "configure",
      revision: 0,
      operationId: randomUUID(),
      mode: "s3",
      kinds: ["image", "video"],
      profile: {
        label: "Private originals",
        bucket: "owned-originals",
        prefix: "private",
        region: "us-east-1",
        endpoint: "https://fixture.invalid",
        forcePathStyle: true,
        credentials: {
          accessKeyId: "test-access-id",
          secretAccessKey: "test-private-secret",
          sessionToken: "test-private-session",
        },
      },
    };
    const admin = { "x-fixture-role": "administrator" };
    for (const headers of [
      { ...admin },
      { ...admin, origin: "https://other.invalid" },
      { ...admin, origin: f.base, "sec-fetch-site": "cross-site" },
    ])
      expect((await f.request("", input, headers)).status).toBe(403);
    expect(await readdir(f.root)).toEqual([]);
    const saved = await f.request("", input, { ...admin, origin: f.base });
    expect(saved.status).toBe(200);
    const json = await saved.json();
    expect(json.savedRevision).toBe(1);
    expect(json.settings.profiles).toHaveLength(1);
    expect(JSON.stringify(json)).not.toContain("test-private");
    expect(JSON.stringify(json)).not.toContain("test-access-id");
    const replay = await f.request("", input, { ...admin, origin: f.base });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(json);
    const status = await f.request("/operations/" + input.operationId, undefined, admin);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      id: input.operationId,
      state: "saved",
      savedRevision: 1,
      currentRevision: 1,
    });
    const stale = await f.request("", { ...input, operationId: randomUUID() }, { ...admin, origin: f.base });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.messageId).toBe("storage.errorConflict");
    const invalid = await f.request(
      "",
      { ...input, revision: 1, operationId: randomUUID(), path: "/outside" },
      { ...admin, origin: f.base },
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.messageId).toBe("storage.errorInvalidConfiguration");
  } finally {
    await f.close();
  }
});
