import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

test("index progress survives restart, coalesces repeated rebuilds and rejects late worker or backwards updates", () => {
  const root = mkdtempSync(join(tmpdir(), "panda-index-progress-")),
    path = join(root, "search.sqlite");
  let now = 1000,
    db = openSearchDatabase(path),
    jobs = new SearchJobs(db, () => now);
  const scope = { source: "builtin", project: "project", owner: "owner" };
  try {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    expect(jobs.view(jobs.get(scope)).progress).toMatchObject({ phase: "queued", total: null, startedAt: null });
    const first = jobs.claim()!;
    expect(jobs.progress(first, { phase: "text", completed: 12, total: 80 })).toBeTrue();
    expect(jobs.progress(first, { phase: "text", completed: 3, total: 80 })).toBeFalse();
    expect(jobs.progress(first, { phase: "reading", completed: 0, total: null })).toBeFalse();
    expect(jobs.progress(first, { phase: "text", completed: 81, total: 80 })).toBeFalse();
    const saved = jobs.view(jobs.get(scope)).progress;
    expect(saved).toMatchObject({ phase: "text", completed: 12, total: 80, startedAt: 1000 });
    expect(jobs.rebuild(scope).token).toBe(first.token);
    db.close();
    db = openSearchDatabase(path);
    jobs = new SearchJobs(db, () => now);
    expect(jobs.view(jobs.get(scope)).progress).toEqual(saved);
    expect(jobs.claim()).toBeNull();
    now += 130000;
    const replacement = jobs.claim()!;
    expect(replacement.token).not.toBe(first.token);
    expect(jobs.view(replacement).progress).toMatchObject({ job: saved!.job, phase: "reading", startedAt: 1000 });
    expect(jobs.progress(first, { phase: "text", completed: 80, total: 80 })).toBeFalse();
    expect(jobs.progress(replacement, { phase: "text", completed: 80, total: 80 })).toBeTrue();
    expect(jobs.progress(replacement, { phase: "activating", completed: 0, total: null })).toBeTrue();
    expect(
      jobs.complete(
        replacement,
        {
          text: { provider: "local", name: "a".repeat(64) },
          vector: null,
          analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
          source: new SearchSourceRegistry(db).get("builtin"),
          sourceRevision: 1,
          settingsRevision: 1,
          embedding: null,
          textFingerprint: "text",
        },
        "saved",
        80,
      ),
    ).toBeTrue();
    expect(jobs.view(jobs.get(scope)).progress).toMatchObject({ phase: "ready", finishedAt: now });
    expect(jobs.progress(replacement, { phase: "text", completed: 80, total: 80 })).toBeFalse();
    const next = jobs.rebuild(scope);
    expect(jobs.view(next).progress).toMatchObject({ phase: "queued", total: null, finishedAt: null });
    expect(jobs.view(next).progress!.job).not.toBe(saved!.job);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-three progress migration preserves original policies, descriptors and audit records", () => {
  const root = mkdtempSync(join(tmpdir(), "panda-index-progress-upgrade-")),
    path = join(root, "search.sqlite");
  let db = openSearchDatabase(path);
  try {
    const jobs = new SearchJobs(db),
      scope = { source: "builtin", project: "project", owner: "owner" };
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: ["private.md"] }, 0);
    const original = db.query("SELECT * FROM search_scopes").all(),
      policy = db.query("SELECT * FROM search_project_policies").all();
    db.exec("DROP TABLE search_progress;PRAGMA user_version=3");
    db.close();
    db = openSearchDatabase(path);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(6);
    expect(db.query("SELECT * FROM search_scopes").all()).toEqual(original);
    expect(db.query("SELECT * FROM search_project_policies").all()).toEqual(policy);
    expect(db.query("SELECT * FROM search_progress").all()).toEqual([]);
    const worker = new SearchJobs(db).claim()!;
    expect(new SearchJobs(db).view(worker).progress?.phase).toBe("reading");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
