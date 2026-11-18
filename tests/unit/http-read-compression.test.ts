import { expect, test } from "bun:test";
import { createServer, get } from "node:http";
import { gunzipSync } from "node:zlib";
import { respondReadJson } from "../../src/server/http/respond.js";
import { withRequestErrors } from "../../src/server/http/request-handler.js";

test("read compression negotiates gzip, preserves JSON and respects explicit refusal", async () => {
  const value = {
    entries: Array.from({ length: 50 }, (_, i) => ({ text: `Prompt ${i} ` + "multibyte 漢字🙂 ".repeat(50) })),
  };
  const server = createServer((req, res) => {
    res.setHeader("Vary", "Origin");
    respondReadJson(req, res, 200, value);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  const read = (encoding: string) =>
    new Promise<{ headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = get(base, { headers: { "accept-encoding": encoding } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on("error", reject);
    });
  try {
    const compressed = await read("br, gzip;q=0.8");
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers["content-length"]).toBe(String(compressed.body.length));
    expect(compressed.headers.vary).toContain("Origin");
    expect(compressed.headers.vary).toContain("Accept-Encoding");
    expect(compressed.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(gunzipSync(compressed.body).toString())).toEqual(value);
    expect(compressed.body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(value)) / 4);
    const refused = await read("gzip;q=0, *;q=1");
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(refused.body.toString())).toEqual(value);
    const plain = await read("identity");
    expect(JSON.parse(plain.body.toString())).toEqual(value);
    expect(await (await fetch(base)).json()).toEqual(value);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("application response timing includes pre-route waits and retains scoped service timing", async () => {
  const server = createServer(
    withRequestErrors(async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.setHeader("Server-Timing", "skill-catalog;dur=1.25");
      respondReadJson(req, res, 200, { ok: true });
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected TCP address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    expect(await response.json()).toEqual({ ok: true });
    const timing = response.headers.get("Server-Timing");
    expect(timing).toContain("skill-catalog;dur=1.25");
    const elapsed = Number(timing?.match(/app;dur=([\d.]+)/)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
