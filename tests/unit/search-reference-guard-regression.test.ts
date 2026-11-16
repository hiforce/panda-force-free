import { expect, test } from "bun:test";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { resourceReferenced } from "../../src/server/search/storage/resource-references.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

test("a damaged uncertainty marker still protects every resource until references are reconciled", () => {
  const db = openSearchDatabase(":memory:");
  try {
    db.query("INSERT INTO search_meta VALUES('unverified-index-references',?)").run("damaged-marker");
    expect(resourceReferenced(db, "a".repeat(64))).toBeTrue();
  } finally {
    db.close();
  }
});

test("a running index cannot activate after its primary project policy is corrupted", () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    scope = { source: "builtin", project: "project", owner: "alice" };
  try {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const work = jobs.claim()!;
    db.query("UPDATE search_project_policies SET settings=? WHERE key=?").run("{broken", work.key);
    expect(
      jobs.complete(
        work,
        {
          text: { provider: "local", name: "a".repeat(64) },
          vector: null,
          source: new SearchSourceRegistry(db).get("builtin"),
          sourceRevision: 1,
          settingsRevision: work.revision,
          analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
          embedding: null,
          textFingerprint: "fixture-text",
        },
        "unchanged-source",
        0,
      ),
    ).toBeFalse();
    expect(db.query<{ active: string | null }, []>("SELECT active FROM search_scopes").get()!.active).toBeNull();
  } finally {
    db.close();
  }
});
