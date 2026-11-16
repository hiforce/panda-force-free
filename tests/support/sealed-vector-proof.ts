import assert from "node:assert/strict";
import { createServer, request as forwardHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { SearchEmbeddings } from "../../src/server/search/providers/embeddings.js";
import { MilvusIndex } from "../../src/server/search/providers/milvus.js";
import { MilvusStorage } from "../../src/server/search/providers/milvus-storage.js";
import { VectorSealStore } from "../../src/server/search/providers/vector-seal.js";
import { SearchError } from "../../src/shared/search/contracts.js";
import { IndexIntegrityError } from "../../src/server/search/integrity.js";

/** A real authenticated storage proof with local synthetic embeddings; no external model or production endpoint is used. */
export async function sealedVectorProof(options: {
  endpoint: () => string;
  password: string;
  root: string;
  restart: () => Promise<void>;
}) {
  let calls = 0;
  const model = createServer(async (req, res) => {
    if (req.url !== "/embeddings" || req.headers.authorization !== "Bearer isolated-model") {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: body.input
          .map((text, index) => ({
            index,
            embedding: text.toLowerCase().includes("durable") ? [0.1, 0.2, 0.3, 0.4] : [0.4, 0.3, 0.2, 0.1],
          }))
          .reverse(),
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  // A service address remains stable across process restart; Docker's published random port may change.
  const proxy = createServer((req, res) => {
    const upstream = forwardHttp(
      new URL(req.url || "/", options.endpoint()),
      { method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode || 503, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + (proxy.address() as AddressInfo).port;
  const name = randomBytes(32).toString("hex"),
    instance = "isolated-sealed-vector",
    signal = AbortSignal.timeout(180000),
    modelHttp = new SearchHttp(
      {
        id: "model",
        kind: "openai",
        url: "http://127.0.0.1:" + (model.address() as AddressInfo).port,
        model: "synthetic",
        dimensions: 4,
      },
      async () => ({ apiKey: "isolated-model" }),
    ),
    storageHttp = () =>
      new SearchHttp({ id: "storage", kind: "milvus", url: endpoint, username: "root" }, async () => ({
        password: options.password,
      })),
    provider = () =>
      new MilvusIndex(storageHttp(), new SearchEmbeddings(modelHttp), instance, new VectorSealStore(options.root)),
    storage = () => new MilvusStorage(storageHttp(), instance),
    documents = [
      { id: "knowledge-a", version: "a".repeat(64), title: "Durable knowledge", text: "Durable saved sources." },
      { id: "knowledge-b", version: "b".repeat(64), title: "Another result", text: "Another reviewed record." },
    ];
  const index = provider();
  let ref: Awaited<ReturnType<MilvusIndex["build"]>> | undefined;
  try {
    ref = await index.build(name, documents, signal);
    assert.equal(ref.integrity?.format, "milvus-seal/1");
    assert.equal(ref.integrity?.count, 2);
    const sealPath = join(options.root, name + ".json"),
      seal = await readFile(sealPath);
    assert.equal(seal.toString().includes("Durable saved"), false);
    assert.equal(seal.toString().includes('"vector"'), false);
    const afterBuild = calls;
    assert.equal((await index.audit(ref, signal)).count, 2);
    assert.equal(calls, afterBuild);
    assert.equal((await index.query(ref, "durable", 10, signal))[0]!.id, "knowledge-a");
    const collectionName = storage().collection(name),
      request = (path: string, body: unknown) => storage().request(path, body, signal),
      data = (
        await request("entities/query", {
          collectionName,
          filter: "",
          limit: 10,
          outputFields: ["id", "knowledge", "version", "text", "start", "vector"],
          consistencyLevel: "Strong",
        })
      ).data as Record<string, unknown>[],
      original = data.find((row) => row.knowledge === "knowledge-a")!;
    for (const mutation of [{ text: "Forged text" }, { version: "c".repeat(64) }, { vector: [0.4, 0.3, 0.2, 0.1] }]) {
      await request("entities/upsert", { collectionName, data: [{ ...original, ...mutation }] });
      const before = calls;
      await assert.rejects(
        index.audit(ref, signal),
        (error: unknown) => error instanceof IndexIntegrityError && error.reason === "corrupt",
      );
      assert.equal(calls, before);
      await request("entities/upsert", { collectionName, data: [original] });
    }
    await request("entities/upsert", { collectionName, data: [{ ...original, version: "c".repeat(64) }] });
    await assert.rejects(index.query(ref, "durable", 10, signal), IndexIntegrityError);
    await request("entities/upsert", { collectionName, data: [original] });
    const extra = { ...original, id: "f".repeat(64) };
    await request("entities/insert", { collectionName, data: [extra] });
    const beforeExtra = calls;
    await assert.rejects(index.query(ref, "durable", 10, signal), IndexIntegrityError);
    assert.equal(calls, beforeExtra);
    await request("entities/delete", { collectionName, filter: 'id == "' + extra.id + '"' });
    const changed = JSON.parse(seal.toString());
    changed.rows[0][1] = "0".repeat(64);
    await writeFile(sealPath, JSON.stringify(changed));
    const beforeSeal = calls;
    await assert.rejects(index.query(ref, "durable", 10, signal), IndexIntegrityError);
    assert.equal(calls, beforeSeal);
    await writeFile(sealPath, seal);
    const denied = new MilvusIndex(
      new SearchHttp({ id: "storage", kind: "milvus", url: endpoint, username: "root" }, async () => ({
        password: "invalid-isolated-password",
      })),
      new SearchEmbeddings(modelHttp),
      instance,
      new VectorSealStore(options.root),
    );
    await assert.rejects(
      denied.audit(ref, signal),
      (error: unknown) => error instanceof SearchError && error.code === "forbidden",
    );
    const beforeRestart = calls;
    await options.restart();
    const deadline = Date.now() + 120000;
    while (true) {
      try {
        await provider().audit(ref, signal);
        break;
      } catch (error) {
        if (!(error instanceof SearchError) || error.code !== "unavailable" || Date.now() > deadline) throw error;
        await Bun.sleep(500);
      }
    }
    assert.equal(calls, beforeRestart);
    assert.equal((await provider().query(ref, "durable", 10, signal))[0]!.id, "knowledge-a");
    await storage().drop(name);
    const beforeMissing = calls;
    await assert.rejects(
      provider().audit(ref, signal),
      (error: unknown) => error instanceof IndexIntegrityError && error.reason === "missing",
    );
    await assert.rejects(provider().query(ref, "durable", 10, signal), IndexIntegrityError);
    assert.equal(calls, beforeMissing);
    await provider().drop(ref);
    ref = undefined;
    return {
      sealedGeneration: true,
      allStoredVectorsAudited: true,
      changedTextVersionVectorDetected: true,
      extraRowsDetected: true,
      hotSealCorruptionDetected: true,
      forbiddenNotRepairable: true,
      namedVolumeRestart: true,
      missingDetectedBeforeInference: true,
      syntheticEmbeddingRequests: calls,
      paidInference: false,
    };
  } finally {
    if (ref)
      await provider()
        .drop(ref)
        .catch(() => {});
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
}
