import MiniSearch from "minisearch";
import { mkdir, open, rename, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SEARCH_LIMITS, SearchError, type SearchDocument } from "../../../shared/search/contracts.js";
import type { IndexReference, SearchAnalyzer, TextIndexProvider } from "../ports.js";
import { IndexIntegrityError } from "../integrity.js";
import { indexBuildProgress, type IndexBuildProgress } from "../progress.js";
import {
  inspectSnapshot,
  readSnapshot,
  snapshotDigest,
  LOCAL_INDEX_FINGERPRINT,
  canRetireLocalIndex,
} from "./local-snapshot.js";
const indexName = (name: string) => {
  if (!/^[a-f0-9]{64}$/.test(name)) throw new SearchError("invalidInput");
  return name;
};
/** Immutable derived generations are published before the ledger activation. Originals are never stored in SQLite. */
export class LocalIndexEngine implements TextIndexProvider {
  readonly id = "local" as const;
  private cache = new Map<string, { index: MiniSearch; bytes: number; stamp: string; digest: string }>();
  constructor(private root: string) {}
  fingerprint() {
    return LOCAL_INDEX_FINGERPRINT;
  }
  canRetire = canRetireLocalIndex;
  async health() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return (await lstat(this.root)).isDirectory();
  }
  private options(analyzer: SearchAnalyzer) {
    return {
      fields: ["title", "text"],
      storeFields: ["title", "version"],
      tokenize: (text: string) => analyzer.tokens(text),
      processTerm: (term: string) => term,
      searchOptions: { boost: { title: 4 }, combineWith: "AND" as const },
    };
  }
  private keep(name: string, index: MiniSearch, bytes: number, stamp: string, digest: string) {
    this.cache.delete(name);
    this.cache.set(name, { index, bytes, stamp, digest });
    let total = [...this.cache.values()].reduce((sum, x) => sum + x.bytes, 0);
    while (this.cache.size > 4 || total > 64 * 1024 * 1024) {
      const key = this.cache.keys().next().value!;
      total -= this.cache.get(key)!.bytes;
      this.cache.delete(key);
    }
  }
  async build(
    name: string,
    documents: SearchDocument[],
    analyzer: SearchAnalyzer,
    signal: AbortSignal,
    progress?: IndexBuildProgress,
  ) {
    indexName(name);
    await this.health();
    if (signal.aborted) throw new SearchError("unavailable", 503);
    const index = new MiniSearch(this.options(analyzer));
    const report = indexBuildProgress(progress);
    let completed = 0;
    report(completed, documents.length);
    for (const document of documents) {
      if (signal.aborted) throw new SearchError("unavailable", 503);
      index.add(document);
      report(++completed, documents.length);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const value = JSON.stringify({ schema: 1, analyzer: analyzer.digest, index: index.toJSON() }),
      bytes = Buffer.byteLength(value);
    if (bytes > SEARCH_LIMITS.indexBytes) throw new SearchError("limit", 409);
    const path = join(this.root, name + ".json"),
      temporary = path + ".tmp",
      file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const dir = await open(this.root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const digest = snapshotDigest(value);
    this.keep(name, index, bytes, await inspectSnapshot(path), digest);
    return {
      name,
      provider: this.id,
      integrity: {
        schema: 1 as const,
        format: "local-json/1",
        digest,
        count: documents.length,
        recipe: analyzer.digest,
      },
    };
  }
  async query(ref: IndexReference, query: string, analyzer: SearchAnalyzer, limit: number, signal: AbortSignal) {
    indexName(ref.name);
    if (ref.provider !== this.id || signal.aborted) throw new SearchError("unavailable", 503);
    const path = join(this.root, ref.name + ".json");
    let cached = this.cache.get(ref.name);
    try {
      if (cached && cached.stamp !== (await inspectSnapshot(path))) {
        this.cache.delete(ref.name);
        cached = undefined;
      }
    } catch (error) {
      this.cache.delete(ref.name);
      throw error;
    }
    if (!cached) {
      const snapshot = await readSnapshot(path, ref, analyzer.digest, signal);
      let index: MiniSearch;
      try {
        index = MiniSearch.loadJSON(JSON.stringify(snapshot.value.index), this.options(analyzer));
      } catch {
        throw new IndexIntegrityError("corrupt");
      }
      this.keep(ref.name, index, snapshot.bytes, snapshot.stamp, snapshot.digest);
      cached = { index, bytes: snapshot.bytes, stamp: snapshot.stamp, digest: snapshot.digest };
    }
    if (
      ref.integrity &&
      (ref.integrity.schema !== 1 ||
        ref.integrity.format !== "local-json/1" ||
        ref.integrity.digest !== cached.digest ||
        ref.integrity.recipe !== analyzer.digest ||
        ref.integrity.count !== cached.index.documentCount)
    )
      throw new IndexIntegrityError("corrupt");
    const hits = cached.index.search(query, {
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 5 ? 0.15 : false),
    });
    return hits.slice(0, limit).map((hit) => ({
      id: String(hit.id),
      title: String(hit.title),
      version: String(hit.version),
      score: hit.score,
      snippet: "",
    }));
  }
  async drop(ref: IndexReference) {
    indexName(ref.name);
    this.cache.delete(ref.name);
    await unlink(join(this.root, ref.name + ".json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async audit(ref: IndexReference, analyzer: SearchAnalyzer, signal: AbortSignal) {
    indexName(ref.name);
    if (ref.provider !== this.id) throw new SearchError("configuration", 409);
    signal.throwIfAborted();
    try {
      const snapshot = await readSnapshot(join(this.root, ref.name + ".json"), ref, analyzer.digest, signal);
      signal.throwIfAborted();
      if (!ref.integrity) throw new IndexIntegrityError("unverified");
      const cached = this.cache.get(ref.name);
      if (cached && (cached.digest !== snapshot.digest || cached.stamp !== snapshot.stamp)) this.cache.delete(ref.name);
      return { count: ref.integrity.count, checks: ["manifest", "bytes", "count", "analyzer"] };
    } catch (error) {
      this.cache.delete(ref.name);
      throw error;
    }
  }
}
