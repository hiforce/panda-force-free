import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createTlsServer } from "node:https";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { ElasticsearchIndex } from "../../src/server/search/providers/elasticsearch.js";
import { elasticsearchFixture } from "../support/elasticsearch-fixture.js";
import { projectSearchText } from "../../src/server/search/providers/text-projection.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";

test("external search uses authenticated bounded JSON, explicit framing, cancellation and no redirects", async () => {
  const requests: {
      url: string;
      method: string;
      body: string;
      length: string | undefined;
      authorization: string | undefined;
    }[] = [],
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({
          url: req.url!,
          method: req.method!,
          body,
          length: req.headers["content-length"],
          authorization: req.headers.authorization,
        });
        if (req.url === "/wait") return;
        if (req.url === "/redirect") {
          res.writeHead(307, { location: "/target", "content-type": "application/json" });
          res.end("{}");
          return;
        }
        if (req.url === "/failure") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ detail: "remote-secret-marker" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const http = new SearchHttp(
    {
      id: "es",
      kind: "elasticsearch",
      url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      username: "elastic",
    },
    async () => ({ password: "synthetic-test-secret" }),
  );
  try {
    const body = { query: "English 文档" };
    await http.request("/write", "POST", body);
    await http.request("/refresh", "POST");
    expect(requests[0]!.length).toBe(String(Buffer.byteLength(JSON.stringify(body))));
    expect(requests[1]!.length).toBe("0");
    expect(requests[0]!.authorization).toBe("Basic " + Buffer.from("elastic:synthetic-test-secret").toString("base64"));
    await expect(http.request("/redirect")).rejects.toThrow("unavailable");
    expect(requests.some((r) => r.url === "/target")).toBe(false);
    await expect(http.request("/failure")).rejects.toThrow("unavailable");
    await expect(http.request("/wait", "GET", undefined, AbortSignal.timeout(100))).rejects.toThrow("unavailable");
  } finally {
    await new Promise<void>((r, e) => {
      server.close((error) =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? e(error) : r(),
      );
      server.closeAllConnections();
    });
  }
});
test("Elasticsearch waits for an active primary and refuses a partial refresh", async () => {
  const fixture = await elasticsearchFixture();
  fixture.faults.healthWaits = 1;
  const http = new SearchHttp({ id: "es", kind: "elasticsearch", url: fixture.url }),
    provider = new ElasticsearchIndex(http, "instance", {
      project: async (document, analyzer) => projectSearchText(document, analyzer),
    });
  try {
    await provider.build(
      "a".repeat(64),
      [
        {
          id: "doc",
          title: "Title",
          text: "Saved English document",
          version: "saved1",
          locale: "en",
          path: "doc.md",
          updatedAt: 1,
          ancestors: [],
        },
      ],
      builtinAnalyzer(),
      new AbortController().signal,
    );
    expect(fixture.healthChecks()).toBe(2);
    const calls = fixture.calls.map((call) => call.path);
    expect(calls.findIndex((p) => p.includes("/_doc/"))).toBeGreaterThan(
      calls.findLastIndex((p) => p.startsWith("/_cluster/health/")),
    );
    expect(calls.at(-1)).toBe("/_search/scroll");
    expect(fixture.scrolls.size).toBe(0);
    fixture.faults.refresh = true;
    await expect(provider.build("c".repeat(64), [], builtinAnalyzer(), new AbortController().signal)).rejects.toThrow(
      "unavailable",
    );
    expect(fixture.calls.at(-1)!.path).toContain("c".repeat(64));
  } finally {
    await fixture.close();
  }
});
test("external search deadlines include a slowly streamed response", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"value":"');
    const timer = setInterval(() => res.write("a"), 10);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const http = new SearchHttp({
    id: "es",
    kind: "elasticsearch",
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
  });
  try {
    await expect(http.request("/", "GET", undefined, undefined, [200], 80)).rejects.toThrow("unavailable");
    await expect(http.request("/", "GET", undefined, undefined, [200], 60001)).rejects.toThrow("configuration");
  } finally {
    await new Promise<void>((r, e) => {
      server.close((error) =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? e(error) : r(),
      );
      server.closeAllConnections();
    });
  }
});
test("failed index creation is cleaned up and unacknowledged deletion stays retryable", async () => {
  const calls: string[] = [],
    server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls.push(req.method!);
      res.setHeader("content-type", "application/json");
      if (req.method === "PUT") {
        res.statusCode = 503;
        res.end("{}");
      } else res.end(JSON.stringify({ acknowledged: false }));
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const provider = new ElasticsearchIndex(
    new SearchHttp({
      id: "es",
      kind: "elasticsearch",
      url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    }),
    "isolated",
    { project: async (document, analyzer) => projectSearchText(document, analyzer) },
  );
  try {
    await expect(provider.build("b".repeat(64), [], builtinAnalyzer(), new AbortController().signal)).rejects.toThrow(
      "unavailable",
    );
    expect(calls).toEqual(["PUT", "DELETE"]);
    await expect(provider.drop({ name: "b".repeat(64), provider: "elasticsearch" })).rejects.toThrow("unavailable");
  } finally {
    await new Promise<void>((r, e) => {
      server.close((error) =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? e(error) : r(),
      );
      server.closeAllConnections();
    });
  }
});
test("external search verifies TLS by default and accepts an administrator CA without disabling verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-search-tls-")),
    key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "pipe" },
  );
  if (generated.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw Error("Could not create isolated TLS fixture");
  }
  const server = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  const port = (server.address() as AddressInfo).port,
    connection = { id: "tls", kind: "elasticsearch" as const, url: "https://127.0.0.1:" + port };
  try {
    await expect(new SearchHttp(connection).request("/")).rejects.toThrow("unavailable");
    expect(await new SearchHttp(connection, async () => ({ ca: await readFile(cert, "utf8") })).request("/")).toEqual({
      ok: true,
    });
    await expect(
      new SearchHttp({ ...connection, url: "https://127.0.0.2:" + port }, async () => ({
        ca: await readFile(cert, "utf8"),
      })).request("/"),
    ).rejects.toThrow("unavailable");
  } finally {
    await new Promise<void>((r, e) => {
      server.close((error) =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? e(error) : r(),
      );
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
});
