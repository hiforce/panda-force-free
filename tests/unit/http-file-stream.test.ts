import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamResponseFile } from "../../src/server/http/file-stream.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("file streaming supports HEAD, cache revalidation and refuses a swapped final symlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panda-stream-")),
    file = join(dir, "asset"),
    link = join(dir, "link");
  writeFileSync(file, "bounded-test-content");
  symlinkSync(file, link);
  const server = createServer(async (req, res) => {
    try {
      await streamResponseFile(req, res, req.url === "/link" ? link : file, { "content-type": "text/plain" }, true);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(base);
  expect(await response.text()).toBe("bounded-test-content");
  expect(response.headers.get("content-length")).toBe("20");
  const etag = response.headers.get("etag")!;
  const head = await fetch(base, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect((await fetch(base, { headers: { "if-none-match": etag.replace("W/", "") } })).status).toBe(304);
  expect((await fetch(base, { headers: { "if-none-match": "*" } })).status).toBe(304);
  expect((await fetch(base + "/link")).status).toBe(404);
  // A response closed early must not leak its descriptor or poison subsequent requests.
  const aborted = await fetch(base);
  await aborted.body?.cancel();
  expect(await (await fetch(base)).text()).toBe("bounded-test-content");
});
