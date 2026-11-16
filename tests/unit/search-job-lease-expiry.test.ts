import { expect, test } from "bun:test";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

for (const operation of ["heartbeat", "complete"] as const)
  test("an expired search worker cannot " + operation + " before another worker has reclaimed its row", () => {
    const db = openSearchDatabase(":memory:");
    let now = 1000000;
    try {
      const jobs = new SearchJobs(db, () => now),
        scope = { source: "builtin", owner: "owner", project: "personal" };
      jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
      const stale = jobs.claim()!,
        source = new SearchSourceRegistry(db).get("builtin"),
        active = {
          text: { name: "a".repeat(64), provider: "local" },
          vector: null,
          source,
          sourceRevision: 1,
          settingsRevision: stale.revision,
          analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
          textFingerprint: "text-v1",
          embedding: null,
        };
      now = stale.leaseUntil! + 1;
      expect(
        operation === "heartbeat" ? jobs.heartbeat(stale) : jobs.complete(stale, active, "saved-version", 1),
      ).toBeFalse();
      expect(jobs.active(jobs.get(scope)!)).toBeNull();
      const recovered = jobs.claim()!;
      expect(recovered.token).not.toBe(stale.token);
      expect(jobs.complete(stale, active, "saved-version", 1)).toBeFalse();
      expect(jobs.heartbeat(recovered)).toBeTrue();
      expect(jobs.complete(recovered, active, "saved-version", 1)).toBeTrue();
    } finally {
      db.close();
    }
  });
