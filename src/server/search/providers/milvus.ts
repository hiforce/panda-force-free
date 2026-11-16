import { SearchError } from "../../../shared/search/contracts.js";
import type {
  VectorIndexProvider,
  IndexReference,
  SearchCandidate,
  SearchVectorDocument,
  SearchEmbeddingProvider,
} from "../ports.js";
import { IndexIntegrityError } from "../integrity.js";
import { SearchHttp } from "./http.js";
import { connectionFingerprint } from "../connection.js";
import { MilvusStorage } from "./milvus-storage.js";
import { VectorSealStore } from "./vector-seal.js";
import { vectorChunks, vectorPageSize, vectorRowDigest } from "./vector-rows.js";
import { auditVectorIndex, verifyVectorRows } from "./vector-audit.js";
import { indexBuildProgress, type IndexBuildProgress } from "../progress.js";
import type { IndexResourceLifecycle } from "../resources/lifecycle.js";

/** Generation orchestration is independent of REST, chunking, sealed metadata and full physical checks. */
export class MilvusIndex implements VectorIndexProvider {
  private readonly storage: MilvusStorage;
  constructor(
    private readonly http: SearchHttp,
    private readonly embeddings: SearchEmbeddingProvider,
    private readonly instance: string,
    private readonly seals: VectorSealStore,
    private readonly resources?: IndexResourceLifecycle,
  ) {
    this.storage = new MilvusStorage(http, instance);
  }
  fingerprint() {
    return (
      connectionFingerprint(this.http.connection) +
      "/" +
      this.embeddings.fingerprint() +
      "/" +
      this.instance +
      "/milvus-seal-v1"
    );
  }
  canRetire(fingerprint: string) {
    const p = fingerprint.split("/");
    return (
      p[0] === connectionFingerprint(this.http.connection) &&
      /^[a-f0-9]{64}$/.test(p[1] || "") &&
      p[2] === "chunks-v1" &&
      p[3] === this.instance &&
      (p.length === 4 || (p.length === 5 && ["approved-v1", "milvus-seal-v1"].includes(p[4]!)))
    );
  }
  async health() {
    await this.storageHealth(new AbortController().signal);
    return this.embeddings.health();
  }
  async storageHealth(signal: AbortSignal) {
    await this.storage.request("collections/list", {}, signal);
    return true;
  }
  audit(ref: IndexReference, signal: AbortSignal) {
    const work = (active: AbortSignal) =>
      auditVectorIndex(this.storage, this.seals, ref, this.fingerprint(), this.embeddings.dimensions, active);
    return this.resources ? this.resources.read(ref.name, signal, work) : work(signal);
  }
  build(
    name: string,
    documents: SearchVectorDocument[],
    signal: AbortSignal,
    progress?: IndexBuildProgress,
  ): Promise<IndexReference> {
    const work = (marker: string | undefined, active: AbortSignal) =>
      this.buildGeneration(name, documents, active, progress, marker);
    return this.resources ? this.resources.build(name, this.fingerprint(), signal, work) : work(undefined, signal);
  }
  private async buildGeneration(
    name: string,
    documents: SearchVectorDocument[],
    signal: AbortSignal,
    progress?: IndexBuildProgress,
    marker?: string,
  ): Promise<IndexReference> {
    const chunks = vectorChunks(documents),
      collectionName = this.storage.collection(name),
      entries: [string, string][] = [];
    if (await this.storage.exists(name, signal)) throw new SearchError("conflict", 409);
    let created = false;
    try {
      await this.storage.request(
        "collections/create",
        {
          collectionName,
          ...(marker ? { description: marker } : {}),
          dimension: this.embeddings.dimensions,
          metricType: "COSINE",
          idType: "VarChar",
          autoID: false,
          primaryFieldName: "id",
          vectorFieldName: "vector",
          params: { max_length: 128, enableDynamicField: true, consistencyLevel: "Strong" },
        },
        signal,
      );
      created = true;
      const report = indexBuildProgress(progress);
      report(0, chunks.length);
      const batchSize = Math.min(16, vectorPageSize(this.embeddings.dimensions));
      for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize),
          vectors = await this.embeddings.embed(
            batch.map((c) => c.text),
            signal,
            "document",
          ),
          rows = batch.map((chunk, i) => ({ ...chunk, vector: vectors[i]! }));
        for (const row of rows) entries.push([row.id, vectorRowDigest(row, this.embeddings.dimensions)]);
        const data = (await this.storage.request("entities/insert", { collectionName, data: rows }, signal)).data as
          { insertCount?: unknown } | undefined;
        if (data?.insertCount !== rows.length) throw new IndexIntegrityError("corrupt");
        report(start + rows.length, chunks.length);
      }
      const ref = await this.seals.put(name, this.fingerprint(), this.embeddings.dimensions, entries, signal);
      await this.audit(ref, signal);
      return ref;
    } catch (error) {
      if (created && !this.resources) {
        await this.storage.drop(name).catch(() => {});
        await this.seals.drop({ name, provider: "milvus" }).catch(() => {});
      }
      throw error;
    }
  }
  query(ref: IndexReference, query: string, limit: number, signal: AbortSignal): Promise<SearchCandidate[]> {
    const work = (active: AbortSignal) => this.readGeneration(ref, query, limit, active);
    return this.resources ? this.resources.read(ref.name, signal, work) : work(signal);
  }
  private async readGeneration(
    ref: IndexReference,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new SearchError("invalidInput");
    const seal = await this.seals.read(ref, this.fingerprint(), this.embeddings.dimensions, signal);
    await this.storage.schema(ref.name, this.embeddings.dimensions, signal);
    if ((await this.storage.count(ref.name, signal)) !== seal.rows.size) throw new IndexIntegrityError("corrupt");
    if (!seal.rows.size) return [];
    const [vector] = await this.embeddings.embed([query], signal, "query"),
      result = await this.storage.request(
        "entities/search",
        {
          collectionName: this.storage.collection(ref.name),
          data: [vector],
          annsField: "vector",
          limit,
          outputFields: ["id"],
          consistencyLevel: "Strong",
        },
        signal,
      );
    if (!Array.isArray(result.data)) throw new SearchError("unavailable", 503);
    const scores = new Map<string, number>();
    for (const row of result.data) {
      if (
        !row ||
        typeof row.id !== "string" ||
        !seal.rows.has(row.id) ||
        typeof row.distance !== "number" ||
        !Number.isFinite(row.distance)
      )
        throw new IndexIntegrityError("corrupt");
      if (!scores.has(row.id)) scores.set(row.id, row.distance);
    }
    if (scores.size > limit) throw new IndexIntegrityError("corrupt");
    const rows = await verifyVectorRows(this.storage, ref.name, seal, [...scores.keys()], signal),
      found = new Map<string, SearchCandidate>();
    for (const [id, score] of scores) {
      const row = rows.get(id)!;
      if (!found.has(row.knowledge))
        found.set(row.knowledge, { id: row.knowledge, version: row.version, title: "", snippet: "", score });
    }
    if ((await this.storage.count(ref.name, signal)) !== seal.rows.size) throw new IndexIntegrityError("corrupt");
    return [...found.values()];
  }
  async drop(ref: IndexReference) {
    if (ref.provider !== "milvus" || (ref.integrity && ref.integrity.format !== "milvus-seal/1"))
      throw new SearchError("configuration", 409);
    if (this.resources) {
      if (!(await this.resources.drop(ref.name, true, AbortSignal.timeout(60000))))
        throw new IndexIntegrityError("unverified");
      return;
    }
    await this.storage.drop(ref.name, !ref.integrity);
    await this.seals.drop(ref);
  }
}
