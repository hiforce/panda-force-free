import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchAudits } from "../../src/server/search/storage/audits.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { AuditOutcome } from "../../src/server/search/audit/contracts.js";
function fixture(path = ":memory:") {
  let now = 1000;
  const db = openSearchDatabase(path),
    jobs = new SearchJobs(db, () => now),
    sources = new SearchSourceRegistry(db),
    audits = new SearchAudits(db, () => now),
    scope = { source: "builtin", owner: "owner", project: "project" };
  if (!jobs.get(scope)) {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    jobs.complete(
      jobs.claim()!,
      {
        text: { name: "a".repeat(64), provider: "local" },
        vector: null,
        analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
        source: sources.get("builtin"),
        sourceRevision: 1,
        settingsRevision: 1,
        embedding: null,
        textFingerprint: "test",
      },
      "saved",
      1,
    );
  }
  return {
    db,
    jobs,
    audits,
    scope,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const healthy: AuditOutcome = { status: "healthy", checks: ["bytes", "count"], count: 1, action: "none" };
test("a first manual audit request survives restart and coalesces with an active lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-manual-audit-")),
    path = join(root, "search.sqlite");
  let f = fixture(path);
  try {
    expect(f.audits.request(f.jobs.get(f.scope)!, 1)).toBeTrue();
    f.db.close();
    f = fixture(path);
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM search_audit_queue").get()!.n).toBe(1);
    const ticket = f.audits.claim(f.jobs.get(f.scope)!, 1)!;
    expect(f.audits.request(f.jobs.get(f.scope)!, 1)).toBeTrue();
    expect(f.audits.claim(f.jobs.get(f.scope)!, 1)).toBeNull();
    expect(f.audits.finish(ticket, healthy, () => true)).toBeTrue();
  } finally {
    f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("search audit leases and completed reports persist without storing document bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-audit-ledger-")),
    path = join(root, "search.sqlite");
  let f = fixture(path);
  try {
    const ticket = f.audits.claim(f.jobs.get(f.scope)!, 1)!;
    expect(f.audits.claim(f.jobs.get(f.scope)!, 1)).toBeNull();
    f.db.close();
    f = fixture(path);
    expect(f.audits.claim(f.jobs.get(f.scope)!, 1)).toBeNull();
    expect(
      f.audits.finish(ticket, healthy, () => {
        throw Error("Unexpected repair");
      }),
    ).toBeTrue();
    f.db.close();
    f = fixture(path);
    const view = f.audits.view(f.jobs.get(f.scope), 1);
    expect(view.current).toBeTrue();
    expect(view.latest?.status).toBe("healthy");
    expect(view.nextAt).toBe(301000);
  } finally {
    f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("report failure rolls back the same transaction's repair admission", () => {
  const f = fixture();
  try {
    const row = f.jobs.get(f.scope)!,
      ticket = f.audits.claim(row, 1)!,
      outcome: AuditOutcome = { ...healthy, status: "corrupt", action: "rebuild" };
    f.db.exec(
      "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON search_audit_reports BEGIN SELECT RAISE(ABORT,'report failed');END",
    );
    expect(() => f.audits.finish(ticket, outcome, () => f.jobs.invalidate(row.key, row))).toThrow("report failed");
    expect(f.jobs.get(f.scope)).toEqual(row);
    f.db.exec("DROP TRIGGER fail_audit");
    expect(f.audits.finish(ticket, outcome, () => f.jobs.invalidate(row.key, row))).toBeTrue();
    expect(f.jobs.get(f.scope)?.state).toBe("queued");
    expect(f.audits.view(f.jobs.get(f.scope), 1).latest?.repairQueued).toBeTrue();
  } finally {
    f.db.close();
  }
});
test("late audits cannot invalidate a newer physical generation or changed settings", () => {
  for (const changedSettings of [false, true]) {
    const f = fixture();
    try {
      const row = f.jobs.get(f.scope)!,
        ticket = f.audits.claim(row, 1)!;
      if (changedSettings) f.jobs.configure(f.scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 1);
      else {
        f.jobs.wake(row.key);
        const next = f.jobs.claim()!;
        f.jobs.complete(
          next,
          { ...f.jobs.active(row)!, text: { name: "b".repeat(64), provider: "local" } },
          "saved",
          1,
        );
      }
      let repairs = 0;
      f.audits.finish(ticket, { ...healthy, status: "missing", action: "rebuild" }, () => {
        repairs++;
        return f.jobs.invalidate(row.key, row);
      });
      expect(repairs).toBe(0);
      expect(f.audits.view(f.jobs.get(f.scope), 1).latest?.status).toBe("superseded");
      expect(f.audits.view(f.jobs.get(f.scope), 1).current).toBeFalse();
    } finally {
      f.db.close();
    }
  }
});
test("rebuild failure preserves bounded backoff for the same generation", () => {
  const f = fixture();
  try {
    const row = f.jobs.get(f.scope)!,
      ticket = f.audits.claim(row, 1)!;
    f.audits.finish(ticket, { ...healthy, status: "missing", action: "rebuild" }, () =>
      f.jobs.invalidate(row.key, row),
    );
    for (let i = 0; i < 3; i++) f.jobs.fail(f.jobs.claim()!, "unavailable");
    expect(f.jobs.get(f.scope)?.state).toBe("failed");
    expect(f.audits.claim(f.jobs.get(f.scope)!, 1)).toBeNull();
    f.advance(30001);
    const next = f.audits.claim(f.jobs.get(f.scope)!, 1)!;
    expect(next).not.toBeNull();
    f.audits.finish(next, { ...healthy, status: "unavailable" }, () => {
      throw Error("Outages cannot rebuild");
    });
    expect(f.audits.view(f.jobs.get(f.scope), 1).nextAt).toBe(91001);
  } finally {
    f.db.close();
  }
});
test("expired leases cannot write reports and retained report history is bounded", () => {
  const f = fixture();
  try {
    const row = f.jobs.get(f.scope)!,
      expired = f.audits.claim(row, 1)!;
    f.advance(120001);
    const next = f.audits.claim(row, 1)!;
    expect(next.token).not.toBe(expired.token);
    expect(f.audits.finish(expired, healthy, () => true)).toBeFalse();
    expect(f.audits.finish(next, healthy, () => true)).toBeTrue();
    for (let i = 0; i < 20; i++) {
      f.audits.request(row, 1);
      f.audits.finish(f.audits.claim(row, 1)!, healthy, () => true);
    }
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM search_audit_reports").get()!.n).toBe(8);
  } finally {
    f.db.close();
  }
});
test("a version-one metadata database upgrades without replacing active source state", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-audit-upgrade-")),
    path = join(root, "search.sqlite");
  let f = fixture(path);
  try {
    const row = f.jobs.get(f.scope)!;
    f.db.exec("DROP TABLE search_audit_reports;DROP TABLE search_audit_queue;PRAGMA user_version=1;");
    f.db.close();
    f = fixture(path);
    expect(f.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(6);
    expect(f.jobs.get(f.scope)).toEqual(row);
    expect(f.audits.claim(row, 1)).not.toBeNull();
  } finally {
    f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
