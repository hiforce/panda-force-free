import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RouteContext } from "../../src/server/http/router.js";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import { approvedSearchKnowledge } from "./search-knowledge-fixture.js";

/** Real production composition and authenticated storage, with a local synthetic model that counts inference separately. */
export async function cachedVectorRuntimeProof(options: { endpoint: string; password: string; root: string }) {
  let inference = 0,
    metadata = 0,
    knowledgeHead = "knowledge-head-one";
  const model = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer isolated-model") return res.writeHead(401).end("{}");
    if (req.url === "/models/synthetic" && req.method === "GET") {
      metadata++;
      res.end(JSON.stringify({ id: "synthetic" }));
      return;
    }
    if (req.url !== "/embeddings" || req.method !== "POST") return res.writeHead(404).end("{}");
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    inference++;
    res.end(
      JSON.stringify({
        data: body.input.map((text, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4 + text.length / 10000] })),
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const documents = Array.from({ length: 22 }, (_, i) => ({
      id: "source-" + i,
      title: "Durable source " + i,
      text: "Saved evidence about durable storage " + i,
      version: "saved-1",
      locale: "en",
      path: "source-" + i + ".md",
      ancestors: [],
      updatedAt: 1,
    })),
    records = documents.map((document, i) => {
      const value = approvedSearchKnowledge([document], "approved-" + i);
      value.record.draft.title += " " + i;
      value.record.version = knowledgeRecordVersion(value.record);
      value.receipt.version = value.record.version;
      return value;
    }),
    errors: unknown[] = [],
    ctx = {} as RouteContext,
    create = () =>
      createSearchFeature({
        stateRoot: options.root,
        appRoot: process.cwd(),
        env: {},
        owner: () => "alice",
        administrator: () => true,
        report: (error) => errors.push(error),
        content: {
          authorize: async () => {},
          head: async () => "saved-head",
          snapshot: async () => ({ commit: "saved-head", documents }),
          current: async (_scope, ids) => documents.filter((d) => ids.includes(d.id)),
        },
        knowledge: {
          head: async () => knowledgeHead,
          snapshot: async () => ({ commit: knowledgeHead, records }),
          current: async (_scope, ids) => records.filter((r) => ids.includes(r.record.id)),
        },
      });
  let feature = await create();
  const ready = async () => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const status = await feature.api.status(ctx, "project-one", "cached");
      if (status.state === "ready") return status;
      if (status.state === "failed") throw Error("Cached vector index failed: " + status.failure);
      await Bun.sleep(50);
    }
    throw Error("Cached vector build did not complete");
  };
  try {
    await feature.api.addConnection(ctx, {
      id: "vectors",
      kind: "milvus",
      url: options.endpoint,
      username: "root",
      password: options.password,
    });
    await feature.api.addConnection(ctx, {
      id: "model",
      kind: "openai",
      url: "http://127.0.0.1:" + (model.address() as AddressInfo).port,
      model: "synthetic",
      dimensions: 4,
      apiKey: "isolated-model",
    });
    await feature.api.addKnowledge(ctx, { id: "retrieval", vectors: "vectors", embeddings: "model" });
    await feature.api.saveSource(ctx, {
      revision: 0,
      source: {
        id: "cached",
        name: "Cached approved knowledge",
        kind: "local",
        connection: null,
        knowledge: "retrieval",
        enabled: true,
      },
    });
    await feature.api.configure(ctx, {
      project: "project-one",
      source: "cached",
      revision: 0,
      settings: {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        fulltext: false,
        vector: true,
        knowledge: { mode: "project", documents: [], subtrees: [], exclude: [] },
      },
    });
    await ready();
    assert.equal(inference, 2);
    const catalog = await feature.api.catalog(ctx),
      source = catalog.sources.find((s) => s.id === "cached")!;
    await feature.api.activate(ctx, {
      source: "cached",
      sourceRevision: source.revision,
      revision: catalog.binding.revision,
    });
    assert.equal(inference, 2);
    assert.equal(metadata, 1);
    const query = () =>
      feature.query(
        "alice",
        { project: "project-one", query: "durable", mode: "semantic" },
        AbortSignal.timeout(30000),
      );
    const first = await query();
    assert.equal(first.hits.length, 20);
    assert.ok(first.nextCursor);
    assert.equal(inference, 3);
    const second = await feature.query(
      "alice",
      { project: "project-one", query: "durable", mode: "semantic", cursor: first.nextCursor },
      AbortSignal.timeout(30000),
    );
    assert.equal(second.hits.length, 2);
    assert.equal(inference, 3);
    await feature.close();
    feature = await create();
    assert.equal((await query()).hits.length, 20);
    assert.equal(inference, 3);
    await feature.api.retry(ctx, { project: "project-one", source: "cached" });
    await ready();
    assert.equal(inference, 3);
    records[0]!.record.draft.title += " updated";
    records[0]!.record.version = knowledgeRecordVersion(records[0]!.record);
    records[0]!.receipt.version = records[0]!.record.version;
    knowledgeHead = "knowledge-head-two";
    await feature.api.retry(ctx, { project: "project-one", source: "cached" });
    await ready();
    assert.equal(inference, 4);
    assert.equal((await feature.status("alice", "project-one")).embedding?.calls, 4);
    assert.equal((await feature.status("bob", "project-one")).embedding?.calls, 0);
    assert.equal((await query()).hits.length, 20);
    assert.equal(inference, 4);
    assert.deepEqual(errors, []);
    return {
      productionRuntimeScopePassed: true,
      realAuthenticatedMilvus: true,
      queryPaginationReusesEmbedding: true,
      restartReusesQueryCache: true,
      forcedRebuildReusesChunks: true,
      oneChangedChunkOnly: true,
      metadataRequests: metadata,
      syntheticEmbeddingRequests: inference,
      paidInference: false,
    };
  } finally {
    await feature.close();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
}
