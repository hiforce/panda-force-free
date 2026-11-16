import { createHash } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import { IndexIntegrityError } from "../integrity.js";
import type { VectorRow } from "./vector-rows.js";
import { SearchHttp } from "./http.js";

/** Only administrator-selected connections and application-owned generation names cross the REST boundary. */
export class MilvusStorage {
  constructor(
    readonly http: SearchHttp,
    private readonly instance: string,
  ) {}
  collection(name: string, legacy = false) {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new SearchError("invalidInput");
    const namespace = legacy
      ? this.instance.slice(0, 12)
      : createHash("sha256").update(this.instance).digest("hex").slice(0, 32);
    return (this.http.connection.prefix || "panda") + "_" + namespace + "_" + name;
  }
  async request(path: string, body: unknown, signal?: AbortSignal) {
    const result = await this.http.request("/v2/vectordb/" + path, "POST", body, signal);
    if (result.code !== 0) throw new SearchError("unavailable", 503);
    return result;
  }
  async exists(name: string, signal?: AbortSignal, legacy = false) {
    const data = (await this.request("collections/has", { collectionName: this.collection(name, legacy) }, signal))
      .data as { has?: unknown } | undefined;
    if (typeof data?.has !== "boolean") throw new SearchError("unavailable", 503);
    return data.has;
  }
  async schema(name: string, dimensions: number, signal: AbortSignal) {
    if (!(await this.exists(name, signal))) throw new IndexIntegrityError("missing");
    const collectionName = this.collection(name),
      data = (await this.request("collections/describe", { collectionName }, signal)).data as
        Record<string, unknown> | undefined;
    if (!data || !Array.isArray(data.fields) || !Array.isArray(data.indexes)) throw new SearchError("unavailable", 503);
    const id = data.fields.find((f) => f.name === "id"),
      vector = data.fields.find((f) => f.name === "vector"),
      dimension = Array.isArray(vector?.params)
        ? vector.params.find((p: { key: string }) => p.key === "dim")?.value
        : vector?.params?.dim;
    if (
      (data.autoId ?? data.autoID) !== false ||
      data.enableDynamicField !== true ||
      id?.type !== "VarChar" ||
      id.primaryKey !== true ||
      vector?.type !== "FloatVector" ||
      Number(dimension) !== dimensions ||
      !data.indexes.some((i) => i.fieldName === "vector" && i.metricType === "COSINE")
    )
      throw new IndexIntegrityError("corrupt");
    if (data.load !== "LoadStateLoaded") await this.request("collections/load", { collectionName }, signal);
  }
  async count(name: string, signal: AbortSignal) {
    const data = (
      await this.request(
        "entities/query",
        { collectionName: this.collection(name), filter: "", outputFields: ["count(*)"], consistencyLevel: "Strong" },
        signal,
      )
    ).data;
    const count = Array.isArray(data) && data.length === 1 ? data[0]?.["count(*)"] : undefined;
    if (!Number.isSafeInteger(count) || count < 0) throw new SearchError("unavailable", 503);
    return count as number;
  }
  async rows(name: string, ids: readonly string[], signal: AbortSignal) {
    const data = (
      await this.request(
        "entities/query",
        {
          collectionName: this.collection(name),
          filter: "id in " + JSON.stringify(ids),
          limit: ids.length,
          outputFields: ["id", "knowledge", "version", "text", "start", "vector"],
          consistencyLevel: "Strong",
        },
        signal,
      )
    ).data;
    if (!Array.isArray(data)) throw new SearchError("unavailable", 503);
    return data as VectorRow[];
  }
  async drop(name: string, legacy = false) {
    if (await this.exists(name, undefined, legacy))
      await this.request("collections/drop", { collectionName: this.collection(name, legacy) });
  }
}
