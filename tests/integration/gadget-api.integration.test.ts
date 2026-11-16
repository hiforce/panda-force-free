import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { GadgetRegistry } from "../../src/server/gadget/registry.js";
import { GadgetStore } from "../../src/server/gadget/store.js";
import { GadgetWorkspaceService } from "../../src/server/gadget/service.js";
import { gadgetRoutes } from "../../src/server/gadget/routes.js";
import { createRouter } from "../../src/server/http/router.js";
import { registerSystemGadgets } from "../../src/gadget/system/server.js";
import { GadgetClient } from "../../src/gadget/sdk/client.js";
import { randomUUID } from "node:crypto";
test("the public gadget API and SDK preserve owner boundaries, revisions, replay and registered-service authorization", async () => {
  const registry = new GadgetRegistry();
  registerSystemGadgets(registry, {
    authorize: (owner) => owner === "one",
    sessions: async () => [],
    attention: async () => [],
    projects: async () => [],
    skills: async () => [],
    bots: async () => ({ counts: { running: 7 } }),
  });
  const store = new GadgetStore(":memory:"),
    service = new GadgetWorkspaceService(registry, store),
    dispatch = createRouter(gadgetRoutes(service, (c) => String(c.req.headers["x-test-owner"] || "")));
  const server = createServer((req, res) => {
    void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number },
    base = "http://127.0.0.1:" + address.port;
  try {
    const transport = ((url: RequestInfo | URL, init?: RequestInit) =>
        fetch(url, { ...init, headers: { ...init?.headers, "x-test-owner": "one", Origin: base } })) as typeof fetch,
      client = new GadgetClient(base, transport);
    expect((await client.catalog()).gadgets).toHaveLength(6);
    const layout = await client.layout(),
      id = randomUUID();
    layout.items[0]!.title = "Private composer";
    const saved = await client.save(layout, id);
    expect(saved.revision).toBe(1);
    expect(await client.save(layout, id)).toEqual(saved);
    await expect(client.save(layout, randomUUID())).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(await client.invoke("system.bots", "bot", {}, "summary")).toEqual({ counts: { running: 7 } });
    const other = new GadgetClient(base, ((url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url, { ...init, headers: { ...init?.headers, "x-test-owner": "other", Origin: base } })) as typeof fetch);
    expect((await other.layout()).revision).toBe(0);
    await expect(other.invoke("system.bots", "bot", {}, "summary")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    const foreign = await fetch(base + "/api/gadgets/data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": "one", Origin: "https://foreign.invalid" },
      body: JSON.stringify({ gadget: "system.bots", name: "summary", instanceId: "one", config: {} }),
    });
    expect(foreign.status).toBe(403);
    const invalid = await fetch(base + "/api/gadgets/data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": "one", Origin: base },
      body: "invalid-json",
    });
    expect(invalid.status).toBe(400);
    await expect(client.invoke("system.bots", "bot", {}, "constructor")).rejects.toMatchObject({
      code: "missing",
      status: 404,
    });
    expect((await fetch(base + "/api/gadgets/layout")).status).toBe(403);
  } finally {
    store.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
