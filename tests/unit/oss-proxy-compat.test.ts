import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test("OSS urllib can use the patched modern proxy agent without contacting an upstream host", async () => {
  const seen: string[] = [];
  const proxy = createServer((req, res) => {
    seen.push(req.url || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"proxied":true}');
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const address = proxy.address() as { port: number };
    const result = await require("urllib").request("http://upstream.example/review", {
      enableProxy: true,
      proxy: "http://127.0.0.1:" + address.port,
      dataType: "json",
      timeout: 2000,
    });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ proxied: true });
    expect(seen).toEqual(["http://upstream.example/review"]);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test("the constrained FTP parser rejects long malformed listings without quadratic backtracking", () => {
  const { parseList } = require("basic-ftp");
  const listing = "-rw-r--r-- 1 " + "a ".repeat(32000) + "!\r\n-rw-r--r-- 1 owner group 42 Jan 1 2020 file.txt\r\n";
  const started = performance.now();
  try {
    parseList(listing);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
  expect(performance.now() - started).toBeLessThan(1000);
});
