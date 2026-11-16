import { expect, test } from "bun:test";
import { ElasticsearchIndex } from "../../src/server/search/providers/elasticsearch.js";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { projectSearchText } from "../../src/server/search/providers/text-projection.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { elasticsearchFixture } from "../support/elasticsearch-fixture.js";

async function fixture(count = 1) {
  const es = await elasticsearchFixture(),
    http = new SearchHttp({ id: "es", kind: "elasticsearch", url: es.url }),
    provider = new ElasticsearchIndex(http, "auditinstance", {
      project: async (document, analyzer) => projectSearchText(document, analyzer),
    }),
    analyzer = builtinAnalyzer(),
    signal = new AbortController().signal;
  try {
    const ref = await provider.build(
        "a".repeat(64),
        Array.from({ length: count }, (_, i) => ({
          id: "document" + i,
          title: "English documentation",
          text: "Immutable saved content " + i,
          version: "saved1",
          locale: "en",
          path: "document" + i + ".md",
          ancestors: [],
          updatedAt: 1,
        })),
        analyzer,
        signal,
      ),
      name = [...es.indexes.keys()][0]!,
      stored = es.indexes.get(name)!;
    return { ...es, http, provider, analyzer, signal, ref, name, stored };
  } catch (error) {
    await es.close();
    throw error;
  }
}
test("ES generation seals and reads back all pages, exact records and primary sequence", async () => {
  const f = await fixture(140);
  try {
    expect(f.ref.integrity?.count).toBe(140);
    expect((await f.provider.audit(f.ref, f.analyzer, f.signal)).checks).toContain("all-records");
    expect(f.calls.filter((call) => call.path === "/_search/scroll" && call.method === "POST").length).toBeGreaterThan(
      2,
    );
    expect(f.scrolls.size).toBe(0);
    expect(await f.provider.query(f.ref, "documentation", f.analyzer, 3, f.signal)).toHaveLength(3);
    expect(
      f.calls.every(
        (call) =>
          call.path.startsWith("/" + f.name) ||
          call.path.startsWith("/_cluster/health/" + f.name) ||
          call.path === "/_search/scroll",
      ),
    ).toBeTrue();
  } finally {
    await f.close();
  }
});
test("ES durable checkpoints detect updates that have not been refreshed", async () => {
  const f = await fixture();
  try {
    await f.http.request("/" + f.name + "/_doc/document0", "PUT", {
      title: "changed",
      text: "changed",
      version: "saved2",
    });
    expect(f.stored.visible.get("document0")?.version).toBe("saved1");
    await expect(f.provider.audit(f.ref, f.analyzer, f.signal)).rejects.toMatchObject({ reason: "corrupt" });
    expect(f.indexes.has(f.name)).toBeTrue();
  } finally {
    await f.close();
  }
});
test.each(["text", "mapping", "count"] as const)(
  "ES deep audit detects %s damage independently of sequence metadata",
  async (damage) => {
    const f = await fixture();
    try {
      if (damage === "text") f.stored.visible.get("document0")!.text = "unexpected body";
      if (damage === "mapping") f.stored.mappings.dynamic = "true";
      if (damage === "count") f.stored.visible.delete("document0");
      await expect(f.provider.audit(f.ref, f.analyzer, f.signal)).rejects.toMatchObject({ reason: "corrupt" });
      expect(f.scrolls.size).toBe(0);
    } finally {
      await f.close();
    }
  },
);
test("ES missing index and reachable legacy index have distinct repair reasons", async () => {
  const f = await fixture();
  try {
    await expect(
      f.provider.audit({ name: f.ref.name, provider: "elasticsearch" }, f.analyzer, f.signal),
    ).rejects.toMatchObject({ reason: "unverified" });
    await f.provider.drop(f.ref);
    await expect(f.provider.audit(f.ref, f.analyzer, f.signal)).rejects.toMatchObject({ reason: "missing" });
    await expect(f.provider.query(f.ref, "text", f.analyzer, 10, f.signal)).rejects.toMatchObject({
      reason: "missing",
    });
  } finally {
    await f.close();
  }
});
test.each([403, 503])("ES upstream %s never becomes proof of physical corruption", async (status) => {
  const f = await fixture();
  try {
    f.faults.path = "/_stats";
    f.faults.status = status;
    try {
      await f.provider.audit(f.ref, f.analyzer, f.signal);
      throw Error("Expected failed audit");
    } catch (error) {
      expect(error).toMatchObject({ code: status === 403 ? "forbidden" : "unavailable" });
      expect(error).not.toHaveProperty("reason");
    }
    expect(f.indexes.has(f.name)).toBeTrue();
  } finally {
    await f.close();
  }
});
test.each(["partial", "timedOut", "scrollExpired"] as const)(
  "ES %s yields an incomplete audit, without requesting index replacement",
  async (fault) => {
    const f = await fixture();
    try {
      f.faults[fault] = true;
      try {
        await f.provider.audit(f.ref, f.analyzer, f.signal);
        throw Error("Expected failed audit");
      } catch (error) {
        expect(error).toMatchObject({ code: "unavailable" });
        expect(error).not.toHaveProperty("reason");
      }
      if (fault !== "scrollExpired")
        await expect(f.provider.query(f.ref, "query", f.analyzer, 10, f.signal)).rejects.toMatchObject({
          code: "unavailable",
        });
      expect(f.scrolls.size).toBe(0);
      expect(f.indexes.has(f.name)).toBeTrue();
    } finally {
      await f.close();
    }
  },
);
test("ES refuses to activate a generation with failed physical readback and removes only its candidate", async () => {
  const f = await fixture();
  try {
    f.faults.partial = true;
    await expect(f.provider.build("b".repeat(64), [], f.analyzer, f.signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect([...f.indexes.keys()]).toEqual([f.name]);
    expect(f.scrolls.size).toBe(0);
  } finally {
    await f.close();
  }
});
