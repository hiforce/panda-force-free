import { expect, test } from "bun:test";
import { checkSearchGeneration } from "../../src/server/search/audit/check.js";
import { IndexIntegrityError } from "../../src/server/search/integrity.js";
import { SearchError } from "../../src/shared/search/contracts.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { searchAuditFixture } from "../support/search-audit-fixture.js";

test("a healthy audit covers the sealed text generation without changing source or job state", async () => {
  const f = searchAuditFixture(),
    scope = f.add(),
    row = f.jobs.get(scope)!;
  try {
    const result = await checkSearchGeneration(f.ports, f.audits.claim(row, 1)!, new AbortController().signal);
    expect(result).toMatchObject({ status: "healthy", action: "none", count: 1 });
    expect(result.checks).toContain("text.bytes");
    expect(f.jobs.get(scope)).toEqual(row);
  } finally {
    f.db.close();
  }
});
test.each(["missing", "corrupt", "unverified"] as const)(
  "confirmed %s generation admits repair after reauthorization",
  async (reason) => {
    const f = searchAuditFixture(),
      scope = f.add();
    try {
      let authorized = 0;
      f.ports.content.authorize = async () => {
        authorized++;
      };
      f.provider.audit = async () => {
        throw new IndexIntegrityError(reason);
      };
      expect(
        await checkSearchGeneration(f.ports, f.audits.claim(f.jobs.get(scope)!, 1)!, new AbortController().signal),
      ).toMatchObject({ status: reason, action: "rebuild" });
      expect(authorized).toBe(2);
    } finally {
      f.db.close();
    }
  },
);
test.each(["source", "provider"] as const)("changed %s during physical read supersedes a finding", async (changed) => {
  const f = searchAuditFixture(),
    scope = f.add();
  try {
    f.provider.audit = async () => {
      if (changed === "source") f.setHead("new-saved");
      else f.setFingerprint("recipe-v2");
      throw new IndexIntegrityError("corrupt");
    };
    expect(
      await checkSearchGeneration(f.ports, f.audits.claim(f.jobs.get(scope)!, 1)!, new AbortController().signal),
    ).toMatchObject({ status: "superseded", action: "none" });
  } finally {
    f.db.close();
  }
});
test.each(["forbidden", "unavailable"] as const)(
  "late %s retains its actual failure category without repair",
  async (code) => {
    const f = searchAuditFixture(),
      scope = f.add();
    try {
      f.provider.audit = async () => {
        f.ports.content.head = async () => {
          throw new SearchError(code, code === "forbidden" ? 403 : 503);
        };
        throw new IndexIntegrityError("missing");
      };
      expect(
        await checkSearchGeneration(f.ports, f.audits.claim(f.jobs.get(scope)!, 1)!, new AbortController().signal),
      ).toMatchObject({ status: code, action: "none" });
    } finally {
      f.db.close();
    }
  },
);
test("a missing text descriptor cannot be reported healthy", async () => {
  const f = searchAuditFixture(),
    scope = f.add();
  try {
    const row = f.jobs.get(scope)!;
    f.jobs.wake(row.key);
    f.jobs.complete(f.jobs.claim()!, { ...f.jobs.active(row)!, text: null }, "saved", 1);
    expect(
      await checkSearchGeneration(f.ports, f.audits.claim(f.jobs.get(scope)!, 1)!, new AbortController().signal),
    ).toMatchObject({ status: "outdated", action: "rebuild" });
  } finally {
    f.db.close();
  }
});
test("an outdated source requires reachable backend and stable final bindings before repair", async () => {
  const f = searchAuditFixture(),
    scope = f.add();
  try {
    f.setHead("new-source");
    const ticket = f.audits.claim(f.jobs.get(scope)!, 1)!;
    f.provider.health = async () => false;
    expect(await checkSearchGeneration(f.ports, ticket, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      action: "none",
    });
    f.provider.health = async () => {
      f.setFingerprint("changed-connection");
      return true;
    };
    expect(await checkSearchGeneration(f.ports, ticket, new AbortController().signal)).toMatchObject({
      status: "superseded",
      action: "none",
    });
  } finally {
    f.db.close();
  }
});
test("vector coverage without approved knowledge and physical vector audits remains explicit partial coverage", async () => {
  const f = searchAuditFixture(),
    scope = f.add("builtin", "project", { ...DEFAULT_SEARCH_SETTINGS, enabled: true, vector: true });
  try {
    f.ports.runtime.vectors = () => ({
      build: async (name) => ({ name, provider: "milvus" }),
      query: async () => [],
      drop: async () => {},
      health: async () => true,
      fingerprint: () => "vector-v1",
    });
    const ticket = f.audits.claim(f.jobs.get(scope)!, 1)!;
    expect(await checkSearchGeneration(f.ports, ticket, new AbortController().signal)).toMatchObject({
      status: "partial",
      action: "none",
    });
    f.ports.knowledge = {
      head: async () => "knowledge-v1",
      current: async () => [],
      snapshot: async () => {
        throw Error("Audits must not embed content");
      },
    };
    const report = await checkSearchGeneration(f.ports, ticket, new AbortController().signal);
    expect(report.status).toBe("partial");
    expect(report.checks).toContain("text.bytes");
  } finally {
    f.db.close();
  }
});
test("cancellation cannot turn an interrupted physical read into a repair", async () => {
  const f = searchAuditFixture(),
    scope = f.add(),
    controller = new AbortController();
  try {
    f.provider.audit = async () => {
      controller.abort();
      throw new IndexIntegrityError("missing");
    };
    expect(
      await checkSearchGeneration(f.ports, f.audits.claim(f.jobs.get(scope)!, 1)!, controller.signal),
    ).toMatchObject({ status: "unavailable", action: "none" });
  } finally {
    f.db.close();
  }
});
test("outdated vector maintenance probes storage without calling embedding health or building content", async () => {
  const f = searchAuditFixture(),
    scope = f.add("builtin", "project", { ...DEFAULT_SEARCH_SETTINGS, enabled: true, vector: true });
  let probes = 0;
  try {
    f.ports.knowledge = {
      head: async () => "knowledge-v1",
      current: async () => [],
      snapshot: async () => {
        throw Error("Maintenance cannot load content for inference");
      },
    };
    const vectors = {
      build: async (): Promise<never> => {
        throw Error("Maintenance cannot embed content");
      },
      query: async () => [],
      drop: async () => {},
      health: async (): Promise<never> => {
        throw Error("Maintenance cannot invoke model health");
      },
      fingerprint: () => "vector-v1",
      storageHealth: async (signal: AbortSignal) => {
        signal.throwIfAborted();
        probes++;
        return true;
      },
    };
    f.ports.runtime.vectors = () => vectors;
    f.setHead("new-source");
    const ticket = f.audits.claim(f.jobs.get(scope)!, 1)!,
      report = await checkSearchGeneration(f.ports, ticket, new AbortController().signal);
    expect(report).toMatchObject({ status: "outdated", action: "rebuild" });
    expect(report.checks).toContain("vector.storage-reachable");
    expect(probes).toBe(1);
    f.ports.runtime.vectors = () => ({ ...vectors, storageHealth: undefined });
    expect(await checkSearchGeneration(f.ports, ticket, new AbortController().signal)).toMatchObject({
      status: "partial",
      action: "none",
    });
    expect(probes).toBe(1);
  } finally {
    f.db.close();
  }
});

test("a complete vector audit requires physical approved knowledge and never repairs source corruption as index damage", async () => {
  const f = searchAuditFixture(),
    scope = f.add("builtin", "project", { ...DEFAULT_SEARCH_SETTINGS, enabled: true, vector: true });
  let reads = 0,
    vectorReads = 0,
    fail = false;
  try {
    const { knowledgeVectorInput } = await import("../../src/server/search/knowledge.js"),
      row = f.jobs.get(scope)!,
      active = f.jobs.active(row)!;
    f.db
      .query("UPDATE search_scopes SET active=? WHERE key=?")
      .run(JSON.stringify({ ...active, vectorInput: knowledgeVectorInput([]) }), row.key);
    f.ports.knowledge = {
      head: async () => "knowledge-v1",
      current: async () => [],
      snapshot: async () => {
        reads++;
        if (fail) throw new IndexIntegrityError("corrupt");
        return { commit: "knowledge-v1", records: [] };
      },
    };
    f.ports.runtime.vectors = () => ({
      fingerprint: () => "vector-v1",
      query: async () => [],
      drop: async () => {},
      build: async () => {
        throw Error("Audit cannot build vectors");
      },
      health: async () => {
        throw Error("Audit cannot run model health");
      },
      audit: async () => {
        vectorReads++;
        return { count: 0, checks: ["all-float32-vectors"] };
      },
    });
    const ticket = f.audits.claim(f.jobs.get(scope)!, 1)!;
    const healthy = await checkSearchGeneration(f.ports, ticket, new AbortController().signal);
    expect(healthy.status).toBe("healthy");
    expect(healthy.checks).toContain("knowledge.approved-files-and-citations");
    expect(reads).toBe(1);
    expect(vectorReads).toBe(1);
    fail = true;
    expect(await checkSearchGeneration(f.ports, ticket, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      action: "none",
    });
    expect(vectorReads).toBe(1);
  } finally {
    f.db.close();
  }
});
