import { createHash } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import { IndexIntegrityError } from "../integrity.js";
import type { IndexReference, SearchAnalyzer } from "../ports.js";
import { SearchHttp, SearchHttpError } from "./http.js";

export type ProjectedSearchText = { title: string; text: string; version: string };
export const projectedTextDigest = (id: string, value: ProjectedSearchText) =>
  createHash("sha256")
    .update(JSON.stringify([id, value.title, value.text, value.version]))
    .digest("hex");
export const projectionSetDigest = (entries: [string, string][]) =>
  createHash("sha256")
    .update(JSON.stringify([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest("hex");

/** A missing owned index is repairable; a missing scroll context is only a failed audit attempt. */
async function ownedIndexRequest(request: Promise<Record<string, unknown>>) {
  try {
    return await request;
  } catch (error) {
    if (error instanceof SearchHttpError && error.responseStatus === 404) throw new IndexIntegrityError("missing");
    throw error;
  }
}

export async function esCheckpoint(http: SearchHttp, index: string, signal: AbortSignal) {
  const result = await ownedIndexRequest(
    http.request(
      "/" +
        index +
        "/_stats?level=shards&filter_path=indices.*.uuid,indices.*.shards.*.routing.primary,indices.*.shards.*.seq_no",
      "GET",
      undefined,
      signal,
    ),
  );
  const row = (
    result.indices as
      | Record<
          string,
          {
            uuid?: unknown;
            shards?: Record<string, { routing?: { primary?: boolean }; seq_no?: { max_seq_no?: unknown } }[]>;
          }
        >
      | undefined
  )?.[index];
  if (typeof row?.uuid !== "string" || !row.shards) throw new SearchError("unavailable", 503);
  const entries = Object.entries(row.shards)
    .sort()
    .map(([id, copies]) => {
      const primary = copies.filter((copy) => copy.routing?.primary);
      if (primary.length !== 1 || !Number.isSafeInteger(primary[0]!.seq_no?.max_seq_no))
        throw new SearchError("unavailable", 503);
      return [id, primary[0]!.seq_no!.max_seq_no];
    });
  if (entries.length !== 1) throw new IndexIntegrityError("corrupt");
  return JSON.stringify([row.uuid, entries]);
}
function pageHits(value: Record<string, unknown>) {
  const shards = value._shards as { failed?: number; successful?: number } | undefined;
  const hits = (value.hits as { hits?: { _id: string; _source: ProjectedSearchText }[] } | undefined)?.hits;
  if (!shards || shards.failed !== 0 || !shards.successful || value.timed_out === true || !Array.isArray(hits))
    throw new SearchError("unavailable", 503);
  return hits;
}
/** A generation is checked against immutable bytes and durable primary sequences, including unrefreshed changes. */
export async function auditElasticsearch(
  http: SearchHttp,
  index: string,
  ref: IndexReference,
  analyzer: SearchAnalyzer,
  signal: AbortSignal,
) {
  let scroll: string | undefined;
  try {
    const before = await esCheckpoint(http, index, signal),
      expected = ref.integrity;
    if (!expected) throw new IndexIntegrityError("unverified");
    if (
      expected.schema !== 1 ||
      expected.format !== "es-documents/1" ||
      expected.recipe !== analyzer.digest ||
      !Number.isSafeInteger(expected.count) ||
      expected.count < 0 ||
      expected.count > 10000 ||
      !Number.isSafeInteger(expected.pageSize) ||
      expected.pageSize! < 1 ||
      expected.pageSize! > 128 ||
      typeof expected.checkpoint !== "string"
    )
      throw new IndexIntegrityError("corrupt");
    if (expected.checkpoint !== before) throw new IndexIntegrityError("corrupt");
    const mapping = await ownedIndexRequest(http.request("/" + index + "/_mapping", "GET", undefined, signal));
    const fields = (
      mapping[index] as
        | {
            mappings?: {
              dynamic?: string;
              _meta?: { pandaSearch?: number; analyzer?: string };
              properties?: Record<string, { type?: string; analyzer?: string }>;
            };
          }
        | undefined
    )?.mappings;
    if (!fields || typeof fields !== "object") throw new SearchError("unavailable", 503);
    if (
      fields?.dynamic !== "strict" ||
      fields._meta?.pandaSearch !== 2 ||
      fields._meta.analyzer !== analyzer.digest ||
      JSON.stringify(Object.keys(fields.properties ?? {}).sort()) !== JSON.stringify(["text", "title", "version"]) ||
      fields.properties?.title?.type !== "text" ||
      fields.properties.title.analyzer !== "whitespace" ||
      fields.properties.text?.type !== "text" ||
      fields.properties.text.analyzer !== "whitespace" ||
      fields.properties.version?.type !== "keyword"
    )
      throw new IndexIntegrityError("corrupt");
    const entries = new Map<string, string>();
    let page = await ownedIndexRequest(
      http.request(
        "/" + index + "/_search?scroll=30s",
        "POST",
        { size: expected.pageSize, sort: ["_doc"], query: { match_all: {} } },
        signal,
      ),
    );
    for (;;) {
      signal.throwIfAborted();
      if (typeof page._scroll_id !== "string" || page._scroll_id.length > 16384)
        throw new SearchError("unavailable", 503);
      scroll = page._scroll_id;
      const hits = pageHits(page);
      if (!hits.length) break;
      for (const hit of hits) {
        if (
          typeof hit._id !== "string" ||
          !hit._id ||
          hit._id.length > 128 ||
          entries.has(hit._id) ||
          typeof hit._source?.title !== "string" ||
          typeof hit._source.text !== "string" ||
          typeof hit._source.version !== "string" ||
          JSON.stringify(Object.keys(hit._source).sort()) !== JSON.stringify(["text", "title", "version"])
        )
          throw new IndexIntegrityError("corrupt");
        entries.set(hit._id, projectedTextDigest(hit._id, hit._source));
        if (entries.size > expected.count) throw new IndexIntegrityError("corrupt");
      }
      page = await http.request("/_search/scroll", "POST", { scroll: "30s", scroll_id: scroll }, signal);
    }
    if ((await esCheckpoint(http, index, signal)) !== before) throw new SearchError("indexChanged", 409);
    if (entries.size !== expected.count || projectionSetDigest([...entries]) !== expected.digest)
      throw new IndexIntegrityError("corrupt");
    return {
      count: entries.size,
      checks: ["manifest", "all-records", "versions", "count", "analyzer", "primary-sequence"],
    };
  } finally {
    if (scroll)
      await http
        .request("/_search/scroll", "DELETE", { scroll_id: [scroll] }, AbortSignal.timeout(2000), [200, 404], 2000)
        .catch(() => {});
  }
}
