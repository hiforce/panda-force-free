import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchConnections } from "../../src/server/search/integration/connections.js";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { SearchEmbeddings } from "../../src/server/search/providers/embeddings.js";

test("embedding health reads exact model metadata without inference, including aliases and denial", async () => {
  const requests: { path: string; method: string; authorization: string | undefined }[] = [];
  let found = true;
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, method: req.method!, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === "Bearer denied") {
      res.writeHead(401).end(JSON.stringify({ secret: "upstream-private" }));
    } else if (req.url === "/models/model%2Fone") {
      res.end(JSON.stringify({ id: found ? "model/one" : "different-model" }));
    } else if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: found ? [{ name: "local-model:latest" }] : [] }));
    } else {
      res.writeHead(500).end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    provider = (kind: "ollama" | "openai", token = "synthetic") =>
      new SearchEmbeddings(
        new SearchHttp(
          {
            id: kind,
            kind,
            url,
            model: kind === "ollama" ? "local-model" : "model/one",
            dimensions: 4,
          },
          async () => ({ apiKey: token }),
        ),
      );
  try {
    expect(await provider("openai").health()).toBe(true);
    expect(await provider("ollama").health()).toBe(true);
    found = false;
    await expect(provider("openai").health()).rejects.toMatchObject({ code: "configuration" });
    await expect(provider("ollama").health()).rejects.toMatchObject({ code: "configuration" });
    await expect(provider("openai", "denied").health()).rejects.toMatchObject({ code: "forbidden" });
    expect(requests.length).toBe(5);
    expect(requests.every((r) => r.method === "GET" && !r.path.includes("embed"))).toBe(true);
    expect(requests[0]!.authorization).toBe("Bearer synthetic");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("immutable retrieval connections encrypt secrets, enforce provider pairing and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-search-connections-")),
    path = join(root, "search.sqlite"),
    configured = [
      { id: "installed", kind: "elasticsearch" as const, url: "http://installed", passwordFile: "/private/secret" },
    ];
  let db = openSearchDatabase(path);
  try {
    let profiles = new SearchConnections(db, configured, root);
    await profiles.add({
      id: "vector",
      kind: "milvus",
      url: "http://storage:19530",
      username: "root",
      password: "private-storage-marker",
    });
    await profiles.add({
      id: "model",
      kind: "openai",
      url: "https://model.example/v1",
      model: "embedding",
      dimensions: 4,
      apiKey: "private-model-marker",
    });
    expect(profiles.addKnowledge({ id: "retrieval", vectors: "vector", embeddings: "model" }).id).toBe("retrieval");
    expect(() => profiles.addKnowledge({ id: "wrong", vectors: "model", embeddings: "vector" })).toThrow(
      "configuration",
    );
    await expect(
      profiles.add({ id: "model", kind: "openai", url: "https://elsewhere", model: "other", dimensions: 4 }),
    ).rejects.toThrow("conflict");
    await expect(profiles.add({ id: "bad", kind: "ollama", url: "http://model", model: "one" })).rejects.toThrow(
      "invalidInput",
    );
    expect(JSON.stringify(profiles.list())).not.toMatch(/private-|passwordFile|apiKey|password/);
    expect(JSON.stringify(db.query("SELECT descriptor,envelope,binding FROM search_connections").all())).not.toMatch(
      /private-storage-marker|private-model-marker/,
    );
    db.close();
    db = openSearchDatabase(path);
    profiles = new SearchConnections(db, configured, root);
    expect(profiles.knowledge()).toEqual([{ id: "retrieval", vectors: "vector", embeddings: "model" }]);
    expect(profiles.list().find((p) => p.id === "installed")!.managed).toBe(false);
    expect(profiles.list().find((p) => p.id === "model")!.managed).toBe(true);
    expect((await readFile(join(root, "config", "search-key"))).length).toBeGreaterThan(0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
