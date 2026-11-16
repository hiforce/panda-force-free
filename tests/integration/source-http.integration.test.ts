import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BoundedSourceHttp } from "../../src/server/packages/source-http.js";

test("source HTTP intake bounds real streams, follows no redirects and cancels stalled bodies", async () => {
  const requests: string[] = [],
    server = createServer((request, response) => {
      const path = new URL(request.url || "/", "http://localhost").pathname;
      requests.push(path);
      if (path === "/redirect") {
        response.writeHead(302, { Location: "/must-not-follow" });
        response.end("DO_NOT_STORE_REMOTE_ERROR_BODY");
        return;
      }
      if (path === "/declared") {
        response.writeHead(200, { "Content-Length": "9999" });
        response.flushHeaders();
        response.write("x");
        return;
      }
      if (path === "/oversized") {
        response.writeHead(200);
        response.write(new Uint8Array(32));
        response.end();
        return;
      }
      if (path === "/slow") {
        response.writeHead(200);
        response.flushHeaders();
        response.write("x");
        return;
      }
      response.end("Original bytes");
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    http = new BoundedSourceHttp(),
    request = (path: string, maxBytes: number) => ({ url: base + path, headers: {}, maxBytes });
  try {
    expect(new TextDecoder().decode((await http.get(request("/ok", 100))).bytes)).toBe("Original bytes");
    const redirect = await http.get(request("/redirect", 100));
    expect(redirect.status).toBe(302);
    expect(redirect.bytes.length).toBe(0);
    expect(requests).not.toContain("/must-not-follow");
    await expect(http.get(request("/declared", 8))).rejects.toThrow("sourceTooLarge");
    await expect(http.get(request("/oversized", 8))).rejects.toThrow("sourceTooLarge");
    await expect(new BoundedSourceHttp(fetch, 80).get(request("/slow", 100))).rejects.toThrow("sourceTimedOut");
    const controller = new AbortController(),
      before = requests.length;
    controller.abort();
    await expect(http.get({ ...request("/cancelled", 100), signal: controller.signal })).rejects.toThrow(
      "sourceCancelled",
    );
    expect(requests.length).toBe(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
