import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchIndexResources } from "../../src/server/search/storage/resources.js";
import { SearchConnections } from "../../src/server/search/integration/connections.js";
import { createVectorMaintenance } from "../../src/server/search/integration/vector-maintenance.js";
import { VectorSealStore } from "../../src/server/search/providers/vector-seal.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { RouteContext } from "../../src/server/http/router.js";

test("storage aliases report the same automatic policy without probing providers or initializing content", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-storage-alias-")),
    db = openSearchDatabase(":memory:"),
    connections = new SearchConnections(
      db,
      [
        { id: "current", kind: "milvus", url: "http://127.0.0.1:9" },
        { id: "alias", kind: "milvus", url: "http://127.0.0.1:9" },
        { id: "model", kind: "openai", url: "http://127.0.0.1:9", model: "synthetic", dimensions: 4 },
      ],
      root,
      [{ id: "retrieval", vectors: "current", embeddings: "model" }],
    ),
    sources = new SearchSourceRegistry(db),
    maintenance = createVectorMaintenance({
      db,
      connections,
      sources,
      instance: "isolated",
      resources: new SearchIndexResources(db),
      seals: new VectorSealStore(join(root, "seals")),
      admin: () => {},
      report: (error) => {
        throw error;
      },
    });
  try {
    const ctx = {} as RouteContext;
    expect((await maintenance.api.vectorStorage(ctx, "alias")).automatic).toBeFalse();
    sources.save(
      {
        id: "builtin",
        name: "Built-in search",
        kind: "local",
        connection: null,
        knowledge: "retrieval",
        enabled: true,
      },
      1,
      () => {},
    );
    new SearchJobs(db).configure(
      { source: "builtin", project: "personal", owner: "test" },
      { ...DEFAULT_SEARCH_SETTINGS, enabled: true, vector: true },
      0,
    );
    expect((await maintenance.api.vectorStorage(ctx, "current")).automatic).toBeTrue();
    expect((await maintenance.api.vectorStorage(ctx, "alias")).automatic).toBeTrue();
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM search_resource_scans").get()!.n).toBe(0);
  } finally {
    await maintenance.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
