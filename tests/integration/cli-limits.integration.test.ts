import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createRouter } from "../../src/server/http/router.js";
import { cliApiRoute, cliRegistrationRoutes } from "../../src/server/cli/integration/http.js";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";

test("timed-out work retains its admission slot until it really stops; incomplete request bodies are terminated", async () => {
  const db = openCliCredentialStore(":memory:"),
    credentials = new CliCredentials(db.store);
  let release!: () => void,
    entered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished!: () => void,
    returned = 0;
  const stopped = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const signals: AbortSignal[] = [];
  const dispatch = createRouter([
    cliApiRoute(
      credentials,
      {
        execute: async (_owner, _id, _args, signal) => {
          if (entered++ < 4) {
            signals.push(signal);
            await gate;
            if (++returned === 4) finished();
          }
          return { documents: [] };
        },
      },
      { timeoutMs: 100 },
    ),
  ]);
  const server = createServer((req, res) => {
    void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) });
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    const issued = await credentials.issue(
      "owner",
      base,
      { name: "Limits", kind: "cli", projects: ["personal"], capabilities: ["content:read"], expiresInDays: 1 },
      async () => {},
    );
    const headers = {
      authorization: "Bearer " + issued.apiKey,
      "x-panda-client-id": issued.registration.clientId,
      "x-panda-cli-protocol": "1",
      "content-type": "application/json",
    };
    const send = () =>
      fetch(base + "/api/cli/v1/execute", {
        method: "POST",
        headers,
        body: JSON.stringify({ schema: 1, command: "documents.list", args: { project: "personal" } }),
      });
    const first = await Promise.all(Array.from({ length: 4 }, send));
    expect(first.map((response) => response.status)).toEqual([503, 503, 503, 503]);
    for (const response of first) expect(await response.text()).not.toContain("documents");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await send()).status).toBe(429);
    release();
    await stopped;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await send()).status).toBe(200);
    const slow = await new Promise<number>((resolve, reject) => {
      const req = request(
        base + "/api/cli/v1/execute",
        { method: "POST", headers: { ...headers, "content-length": "100" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.write("{");
    });
    expect(slow).toBe(503);
    expect((await send()).status).toBe(200);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}, 10000);
test("late project authorization after a registration timeout cannot issue a hidden key", async () => {
  const db = openCliCredentialStore(":memory:"),
    credentials = new CliCredentials(db.store);
  let release!: () => void, complete!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    settled = new Promise<void>((resolve) => {
      complete = resolve;
    });
  const dispatch = createRouter(
    cliRegistrationRoutes(credentials, {
      owner: () => "owner",
      authorize: async () => {
        await gate;
      },
      timeoutMs: 100,
    }),
  );
  const server = createServer((req, res) => {
    void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) }).finally(complete);
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    const response = await fetch(base + "/api/cli/clients", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Delayed",
        kind: "cli",
        projects: ["personal"],
        capabilities: ["content:read"],
        expiresInDays: 1,
      }),
    });
    expect(response.status).toBe(503);
    expect(await credentials.list("owner")).toEqual([]);
    release();
    await settled;
    expect(await credentials.list("owner")).toEqual([]);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
