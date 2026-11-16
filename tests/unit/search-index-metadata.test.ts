import { expect, test } from "bun:test";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { SearchIndexMetadata } from "../../src/server/search/storage/index-metadata.js";
import { decodeSearchIndex } from "../../src/server/search/descriptor.js";
import { retireSearchGenerations } from "../../src/server/search/retirement.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { ActiveSearchIndex, SearchJobRow } from "../../src/server/search/state.js";

function fixture(project = "project") {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db);
  const scope = { source: "builtin", project, owner: "owner" };
  jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: ["private.md"] }, 0);
  const active: ActiveSearchIndex = {
    text: { name: "a".repeat(64), provider: "local" },
    vector: null,
    analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
    source: sources.get("builtin"),
    sourceRevision: 1,
    settingsRevision: 1,
    embedding: null,
    textFingerprint: "text",
  };
  jobs.complete(jobs.claim()!, active, "saved-source", 1);
  const raw = () => db.query<SearchJobRow, []>("SELECT * FROM search_scopes").get()!;
  const corrupt = (value: string | null) => db.query("UPDATE search_scopes SET active=?").run(value);
  return { db, jobs, scope, active, raw, corrupt };
}

test("repeated rebuild requests join one durable job and preserve its running worker lease", () => {
  const f = fixture();
  try {
    const initial = f.jobs.get(f.scope)!;
    const queued = f.jobs.rebuild(f.scope);
    expect(queued.requested).toBe(initial.requested + 1);
    expect(f.jobs.active(queued)?.invalidated).toBeTrue();
    expect(f.jobs.rebuild(f.scope)).toEqual(queued);
    const worker = f.jobs.claim()!;
    expect(f.jobs.rebuild(f.scope)).toEqual(worker);
    expect(f.jobs.heartbeat(worker)).toBeTrue();
    expect(f.jobs.complete(worker, f.active, "saved-source", 1)).toBeTrue();
    const next = f.jobs.rebuild(f.scope);
    expect(next.requested).toBe(queued.requested + 1);
    f.jobs.configure(f.scope, { ...DEFAULT_SEARCH_SETTINGS }, 1);
    expect(() => f.jobs.rebuild(f.scope)).toThrow("notReady");
    expect(f.jobs.get(f.scope)?.state).toBe("disabled");
  } finally {
    f.db.close();
  }
});

test.each([
  ["malformed JSON", "{broken"],
  ["null", "null"],
  ["array", "[]"],
  ["empty object", "{}"],
  ["invalid reference", '{"text":true}'],
  ["string", '"text"'],
  ["oversized", "x".repeat(65537)],
  ["empty bytes", ""],
])(
  "invalid derived index metadata is automatically fenced and recovered without widening primary rules: %s",
  (_label, value) => {
    const f = fixture();
    try {
      const rules = f.db.query("SELECT * FROM search_project_policies").get();
      f.corrupt(value);
      const old = f.raw(),
        repaired = f.jobs.get(f.scope)!;
      expect(repaired).toMatchObject({ state: "queued", active: null, token: null, documentCount: 0, commitId: null });
      expect(repaired.requested).toBe(old.requested + 1);
      expect(repaired.revision).toBe(old.revision);
      expect(f.jobs.settings(repaired).exclude).toEqual(["private.md"]);
      expect(f.db.query("SELECT * FROM search_project_policies").get()).toEqual(rules);
      expect(f.db.query<{ descriptor: string }, []>("SELECT descriptor FROM search_retired").get()?.descriptor).toBe(
        value,
      );
      expect(f.jobs.referencesUncertain()).toBeTrue();
      expect(f.jobs.get(f.scope)).toEqual(repaired);
      expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM search_retired").get()?.n).toBe(1);
    } finally {
      f.db.close();
    }
  },
);

test("descriptor validation binds source, provider, generation and integrity while accepting legacy unsealed references", () => {
  const f = fixture();
  try {
    expect(decodeSearchIndex(JSON.stringify(f.active), "builtin")).toEqual(f.active);
    const mutations = [
      { source: { ...f.active.source, id: "another-source" } },
      { text: { provider: "milvus", name: "a".repeat(64) } },
      { text: { provider: "local", name: "../../outside" } },
      { sourceRevision: -1 },
      { settingsRevision: 1.5 },
      { invalidated: "false" },
      { source: { ...f.active.source, connection: "foreign" } },
      {
        text: {
          ...f.active.text,
          integrity: { schema: 1, format: "milvus-seal/1", digest: "a".repeat(64), count: 1, recipe: "recipe" },
        },
      },
      { vector: { provider: "unknown", name: "b".repeat(64) } },
    ];
    for (const change of mutations) {
      const value = { ...f.active, ...change };
      expect(decodeSearchIndex(JSON.stringify(value), "builtin")).toBeNull();
      f.corrupt(JSON.stringify(value));
      expect(f.jobs.get(f.scope)?.state).toBe("queued");
      expect(f.jobs.claim()?.token).not.toBeNull();
    }
  } finally {
    f.db.close();
  }
});

test("a late corrupted row cannot replace or invalidate a newer active generation", () => {
  const f = fixture();
  try {
    f.corrupt("{broken");
    const stale = f.raw();
    f.jobs.get(f.scope);
    const worker = f.jobs.claim()!;
    const fresh = { ...f.active, text: { provider: "local", name: "b".repeat(64) } };
    expect(f.jobs.complete(worker, fresh, "saved-source", 1)).toBeTrue();
    const before = f.raw();
    expect(new SearchIndexMetadata(f.db).recover(stale)).toEqual(before);
    expect(f.jobs.active(stale)).toBeNull();
    expect(f.jobs.invalidate(stale.key, stale)).toBeFalse();
    expect(f.jobs.complete(stale, f.active, "old-source", 1)).toBeFalse();
    expect(f.raw()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("missing ready metadata and personal slots recover; disabled or review-required rules stay closed", () => {
  for (const project of ["project", "personal"]) {
    const f = fixture(project);
    try {
      f.corrupt(null);
      expect(f.jobs.get(f.scope)?.state).toBe("queued");
      expect(f.jobs.referencesUncertain()).toBeFalse();
      f.jobs.configure(f.scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: false }, 1);
      f.corrupt("[]");
      expect(f.jobs.get(f.scope)?.state).toBe("disabled");
      expect(f.jobs.claim()).toBeNull();
    } finally {
      f.db.close();
    }
  }
});

test("unreadable personal or project primary rules never become defaults during derived recovery", () => {
  for (const project of ["project", "personal"]) {
    const f = fixture(project);
    try {
      f.corrupt("{broken");
      if (project === "personal") f.db.exec("UPDATE search_scopes SET settings='{bad'");
      else f.db.exec("UPDATE search_project_policies SET settings='{bad'");
      const before = f.raw();
      expect(() => f.jobs.get(f.scope)).toThrow();
      expect(f.raw()).toEqual(before);
      expect(f.db.query("SELECT 1 FROM search_retired").get()).toBeNull();
    } finally {
      f.db.close();
    }
  }
});

test("one corrupt primary policy cannot widen its scope or starve another project's pending build", () => {
  const f = fixture();
  try {
    f.jobs.configure({ ...f.scope, project: "other" }, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    f.corrupt("{broken");
    f.db.query("UPDATE search_project_policies SET settings='{broken-primary' WHERE project=?").run(f.scope.project);
    const damaged = f.raw();
    expect(() => f.jobs.get(f.scope)).toThrow("configuration");
    expect(f.jobs.all().find((row) => row.project === f.scope.project)).toMatchObject({
      state: "failed",
      failure: "configuration",
    });
    const worker = f.jobs.claim()!;
    expect(worker.project).toBe("other");
    expect(worker.token).not.toBeNull();
    expect(f.db.query("SELECT * FROM search_scopes WHERE project=?").get(f.scope.project)).toEqual(damaged);
    expect(f.jobs.referencesUncertain()).toBeTrue();
  } finally {
    f.db.close();
  }
});

test("a rejected recovery transaction retains the original descriptor and worker fence", () => {
  const f = fixture();
  try {
    f.corrupt("{broken");
    const before = f.raw();
    f.db.exec(
      "CREATE TEMP TRIGGER reject_archive BEFORE INSERT ON search_retired BEGIN SELECT RAISE(ABORT,'archive rejected'); END",
    );
    expect(() => f.jobs.get(f.scope)).toThrow("archive rejected");
    expect(f.raw()).toEqual(before);
    expect(f.jobs.referencesUncertain()).toBeFalse();
  } finally {
    f.db.close();
  }
});

test("corrupt retired records never select a provider and unknown active references preserve physical resources", async () => {
  const f = fixture();
  let calls = 0;
  const runtime = {
    text: () => {
      calls++;
      throw Error("Unexpected physical deletion");
    },
    vectors: () => {
      calls++;
      return null;
    },
  };
  try {
    f.db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,0)").run('{"text":true}');
    await retireSearchGenerations(f.jobs, runtime, 0, () => {
      throw Error("Invalid descriptors should be retained");
    });
    expect(calls).toBe(0);
    expect(f.jobs.retired()).toHaveLength(1);
    f.corrupt("{broken");
    f.jobs.get(f.scope);
    f.db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,0)").run(JSON.stringify(f.active));
    await retireSearchGenerations(f.jobs, runtime, 0, () => {});
    expect(calls).toBe(0);
    expect(f.jobs.retired()).toHaveLength(2);
  } finally {
    f.db.close();
  }
});
