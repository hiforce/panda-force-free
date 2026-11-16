import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbeddingDatabase } from "../../src/server/search/embeddings/database.js";
import { EmbeddingBudget } from "../../src/server/search/embeddings/budget.js";
import { embeddingPolicy } from "../../src/server/search/embeddings/policy.js";

test("budgets reserve atomically, persist charged failures and preserve newer concurrent cooldowns", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-embedding-budget-")),
    path = join(root, "ledger.sqlite"),
    policy = embeddingPolicy({
      callsPerDay: 10,
      ownerCallsPerDay: 2,
      charactersPerDay: 100,
      ownerCharactersPerDay: 50,
    });
  let now = 1000000,
    db = openEmbeddingDatabase(path);
  try {
    let budget = new EmbeddingBudget(db, policy, () => now);
    const first = budget.admit("model", "alice", 20),
      second = budget.admit("model", "alice", 20);
    budget.complete(second, "model", true, false);
    budget.complete(first, "model", false, false);
    expect(() => budget.admit("model", "bob", 1)).toThrow("limit");
    db.close();
    db = openEmbeddingDatabase(path);
    budget = new EmbeddingBudget(db, policy, () => now);
    expect(() => budget.admit("model", "bob", 1)).toThrow("limit");
    now += 5001;
    expect(() => budget.admit("model", "alice", 1)).toThrow("limit");
    const bob = budget.admit("model", "bob", 40);
    budget.complete(bob, "model", false, false);
    expect(() => budget.admit("model", "bob", 20)).toThrow("limit");
    expect(
      db
        .query<{ calls: number; characters: number }, []>(
          "SELECT calls,characters FROM embedding_usage WHERE bucket='day'",
        )
        .get(),
    ).toEqual({ calls: 3, characters: 80 });
    db.exec(
      "CREATE TRIGGER reject_reservation BEFORE INSERT ON embedding_inflight BEGIN SELECT RAISE(ABORT,'unavailable'); END;",
    );
    expect(() => budget.admit("other", "charlie", 1)).toThrow();
    expect(db.query<{ calls: number }, []>("SELECT calls FROM embedding_usage WHERE bucket='day'").get()!.calls).toBe(
      3,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedding policy rejects unknown, unbounded and inconsistent administrator limits", () => {
  for (const value of [
    { concurrent: 0 },
    { unexpected: true },
    { cacheBytes: Infinity },
    { ownerCallsPerDay: 2000 },
    { queryTtlMinutes: 0 },
  ])
    expect(() => embeddingPolicy(value)).toThrow("configuration");
});
