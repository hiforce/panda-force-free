import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import { SearchError } from "../../src/shared/search/contracts.js";

test("index status authorizes its owner scope without creating a job, loading bodies or requesting providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-search-status-")),
    seen: string[] = [],
    feature = await createSearchFeature({
      stateRoot: root,
      appRoot: process.cwd(),
      env: {},
      content: {
        authorize: async (scope) => {
          seen.push(scope.owner + ":" + scope.project);
          if (scope.project !== "project-1") throw new SearchError("forbidden", 403);
        },
        head: async () => {
          throw new Error("Status must not load a source head");
        },
        snapshot: async () => {
          throw new Error("Status must not load source bodies");
        },
        current: async () => {
          throw new Error("Status must not retrieve search candidates");
        },
      },
      owner: () => "alice",
      administrator: () => false,
      report: (error) => {
        throw error;
      },
    });
  try {
    for (const owner of ["alice", "bob", "alice"]) {
      const result = await feature.status(owner, "project-1");
      expect(result.state).toBe("disabled");
      expect(result.settings.enabled).toBe(false);
      expect(result.ready).toBe(false);
      expect(result.source).toBe("builtin");
    }
    await expect(feature.status("alice", "elsewhere")).rejects.toThrow("forbidden");
    expect(seen).toEqual(["alice:project-1", "bob:project-1", "alice:project-1", "alice:elsewhere"]);
    const db = new Database(join(root, "data", "search.sqlite"), { readonly: true });
    try {
      expect(db.query<{ n: number }, []>("SELECT count(*) n FROM search_scopes").get()!.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await feature.close();
    await rm(root, { recursive: true, force: true });
  }
});
