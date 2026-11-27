import type { SearchDocument } from "../../../shared/search/contracts.js";
import { SearchError } from "../../../shared/search/contracts.js";
import type { IndexReference, SearchAnalyzer, TextIndexProvider, SearchTextProjector } from "../ports.js";
import { SearchHttp } from "./http.js";
import { connectionFingerprint } from "../connection.js";
import { auditElasticsearch, esCheckpoint, projectedTextDigest, projectionSetDigest } from "./es-integrity.js";
import { IndexIntegrityError } from "../integrity.js";
import { SearchHttpError } from "./http.js";
import { indexBuildProgress, type IndexBuildProgress } from "../progress.js";
/** ES7-compatible typeless APIs; private generation names never overlap pre-existing business indexes. */
export class ElasticsearchIndex implements TextIndexProvider {
  readonly id = "elasticsearch" as const;
  constructor(
    private http: SearchHttp,
    private instance: string,
    private projector: SearchTextProjector,
  ) {}
  fingerprint() {
    return connectionFingerprint(this.http.connection) + "/es-v2/" + this.instance;
  }
  canRetire(fingerprint: string) {
    return (
      fingerprint === this.fingerprint() ||
      fingerprint === connectionFingerprint(this.http.connection) + "/es-v1/" + this.instance
    );
  }
  private name(name: string) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new SearchError("invalidInput");
    return (this.http.connection.prefix || "panda") + "_" + this.instance.slice(0, 12) + "_" + name;
  }
  async health() {
    const result = await this.http.request("/");
    return typeof (result.version as { number?: string } | undefined)?.number === "string";
  }
  async build(
    name: string,
    documents: SearchDocument[],
    analyzer: SearchAnalyzer,
    signal: AbortSignal,
    progress?: IndexBuildProgress,
  ) {
    const index = this.name(name);
    try {
      await this.http.request(
        "/" + index + "?timeout=30s&master_timeout=10s",
        "PUT",
        {
          settings: { number_of_shards: 1, number_of_replicas: 0 },
          mappings: {
            dynamic: "strict",
            _meta: { pandaSearch: 2, analyzer: analyzer.digest },
            properties: {
              title: { type: "text", analyzer: "whitespace" },
              text: { type: "text", analyzer: "whitespace" },
              version: { type: "keyword" },
            },
          },
        },
        signal,
        [200, 201],
        60000,
      );
      const deadline = Date.now() + 60000;
      for (;;) {
        signal.throwIfAborted();
        const health = await this.http.request(
          "/_cluster/health/" + index + "?wait_for_active_shards=1&timeout=2s&master_timeout=3s",
          "GET",
          undefined,
          signal,
          [200, 408],
        );
        if (Number(health.active_primary_shards) >= 1 && health.timed_out === false) break;
        if (Date.now() >= deadline) throw new SearchError("unavailable", 503);
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
              clearTimeout(timer);
              reject(new SearchError("unavailable", 503));
            },
            timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, 250);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      const entries: [string, string][] = [];
      const report = indexBuildProgress(progress);
      let completed = 0;
      report(completed, documents.length);
      let largest = 1;
      for (const d of documents) {
        const projected = await this.projector.project(d, analyzer, signal);
        largest = Math.max(largest, Buffer.byteLength(JSON.stringify(projected)) + 512);
        entries.push([d.id, projectedTextDigest(d.id, projected)]);
        await this.http.request("/" + index + "/_doc/" + encodeURIComponent(d.id), "PUT", projected, signal);
        report(++completed, documents.length);
      }
      const refreshed = await this.http.request("/" + index + "/_refresh", "POST", undefined, signal, [200], 60000),
        shards = refreshed._shards as { successful?: number; failed?: number } | undefined;
      if (!shards || shards.failed !== 0 || !shards.successful) throw new SearchError("unavailable", 503);
      const reference: IndexReference = {
        name,
        provider: this.id,
        integrity: {
          schema: 1,
          format: "es-documents/1",
          digest: projectionSetDigest(entries),
          count: documents.length,
          recipe: analyzer.digest,
          pageSize: Math.min(128, Math.max(1, Math.floor((4 * 1024 * 1024) / largest))),
          checkpoint: await esCheckpoint(this.http, index, signal),
        },
      };
      await this.audit(reference, analyzer, signal);
      return reference;
    } catch (error) {
      await this.drop({ name, provider: this.id }).catch(() => {});
      throw error;
    }
  }
  async query(
    ref: IndexReference,
    query: string,
    analyzer: SearchAnalyzer,
    limit: number,
    signal: AbortSignal,
    options?: { match?: "any" },
  ) {
    const terms = analyzer.tokens(query);
    if (!terms.length) return [];
    const result = await this.http
      .request(
        "/" + this.name(ref.name) + "/_search",
        "POST",
        {
          size: limit,
          _source: ["version"],
          query: {
            multi_match: {
              query: terms.join(" "),
              fields: ["title^4", "text"],
              operator: options?.match === "any" ? "or" : "and",
              fuzziness: "AUTO",
            },
          },
        },
        signal,
      )
      .catch((error) => {
        if (error instanceof SearchHttpError && error.responseStatus === 404) throw new IndexIntegrityError("missing");
        throw error;
      });
    const hits = (result.hits as { hits?: { _id: string; _score: number; _source: { version: string } }[] } | undefined)
      ?.hits;
    const shards = result._shards as { failed?: number; successful?: number } | undefined;
    if (!Array.isArray(hits) || !shards || shards.failed !== 0 || !shards.successful || result.timed_out === true)
      throw new SearchError("unavailable", 503);
    return hits.map((h) => ({ id: h._id, title: "", version: h._source.version, score: h._score, snippet: "" }));
  }
  audit(ref: IndexReference, analyzer: SearchAnalyzer, signal: AbortSignal) {
    if (ref.provider !== this.id) throw new SearchError("configuration", 409);
    return auditElasticsearch(this.http, this.name(ref.name), ref, analyzer, signal);
  }
  async drop(ref: IndexReference, signal?: AbortSignal) {
    const result = await this.http.request(
      "/" + this.name(ref.name) + "?timeout=30s&master_timeout=10s",
      "DELETE",
      undefined,
      signal,
      [200, 404],
      60000,
    );
    if (result.acknowledged !== true && result.status !== 404) throw new SearchError("unavailable", 503);
  }
}
