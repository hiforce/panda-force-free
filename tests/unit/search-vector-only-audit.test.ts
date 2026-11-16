import { expect, test } from "bun:test";
import { checkSearchGeneration } from "../../src/server/search/audit/check.js";
import { SearchAuditRunner } from "../../src/server/search/audit/runner.js";
import { knowledgeVectorInput } from "../../src/server/search/knowledge.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { searchAuditFixture } from "../support/search-audit-fixture.js";

function fixture() {
  const f = searchAuditFixture(),
    scope = f.add("builtin", "project", { ...DEFAULT_SEARCH_SETTINGS, enabled: true, fulltext: false, vector: true });
  let disabledTextReads = 0,
    storageChecks = 0;
  const row = f.jobs.get(scope)!;
  f.jobs.wake(row.key, true);
  f.jobs.complete(f.jobs.claim()!, { ...f.jobs.active(row)!, vectorInput: knowledgeVectorInput([]) }, "saved", 0);
  f.ports.runtime.text = () => {
    disabledTextReads++;
    throw Error("Disabled full-text provider is unavailable");
  };
  f.ports.runtime.vectors = () => ({
    fingerprint: () => "vector-v1",
    health: async () => {
      throw Error("Model health is not a storage probe");
    },
    storageHealth: async () => {
      storageChecks++;
      return true;
    },
    audit: async () => ({ count: 0, checks: ["seal", "rows"] }),
    build: async () => {
      throw Error("Audit cannot build vectors");
    },
    query: async () => {
      throw Error("Audit cannot run a model query");
    },
    drop: async () => {},
  });
  f.ports.knowledge = {
    head: async () => "knowledge-v1",
    snapshot: async () => ({ commit: "knowledge-v1", records: [] }),
    current: async () => [],
  };
  return { ...f, scope, counts: () => ({ disabledTextReads, storageChecks }) };
}

test("a vector-only physical audit verifies approved files and vectors without constructing the disabled text adapter", async () => {
  const f = fixture();
  try {
    const result = await checkSearchGeneration(
      f.ports,
      f.audits.claim(f.jobs.get(f.scope)!, 1)!,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "healthy", action: "none" });
    expect(result.checks).toContain("knowledge.approved-files-and-citations");
    expect(result.checks).toContain("vector.seal");
    expect(f.counts().disabledTextReads).toBe(0);
  } finally {
    f.db.close();
  }
});

test("an outdated vector-only generation checks storage reachability without touching disabled text or model health", async () => {
  const f = fixture();
  try {
    f.ports.knowledge!.head = async () => "knowledge-v2";
    expect(
      await checkSearchGeneration(f.ports, f.audits.claim(f.jobs.get(f.scope)!, 1)!, new AbortController().signal),
    ).toMatchObject({ status: "outdated", action: "rebuild" });
    expect(f.counts()).toEqual({ disabledTextReads: 0, storageChecks: 1 });
  } finally {
    f.db.close();
  }
});

test("the periodic vector-only audit slot also uses the enabled provider for backoff identity", async () => {
  const f = fixture(),
    errors: unknown[] = [],
    runner = new SearchAuditRunner(
      f.ports,
      f.audits,
      () => {
        throw Error("Healthy vectors do not rebuild");
      },
      (e) => errors.push(e),
    );
  try {
    runner.start();
    const end = Date.now() + 600;
    while (!f.audits.view(f.jobs.get(f.scope), 1).latest) {
      if (Date.now() > end) throw Error("Vector-only audit did not settle");
      await Bun.sleep(5);
    }
    expect(f.audits.view(f.jobs.get(f.scope), 1).latest?.status).toBe("healthy");
    expect(errors).toEqual([]);
    expect(f.counts().disabledTextReads).toBe(0);
  } finally {
    await runner.close();
    f.db.close();
  }
});
