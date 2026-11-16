import { SearchError } from "../../../shared/search/contracts.js";
import { SearchHttp } from "./http.js";
import { float32Vector } from "./vector-rows.js";
import { connectionFingerprint } from "../connection.js";

/** Models are administrator-selected. This adapter never downloads models or discovers paid providers. */
export class SearchEmbeddings {
  constructor(private http: SearchHttp) {
    const c = http.connection;
    if (
      !["ollama", "openai"].includes(c.kind) ||
      !c.model ||
      !Number.isSafeInteger(c.dimensions) ||
      Number(c.dimensions) < 1 ||
      Number(c.dimensions) > 65536
    )
      throw new SearchError("configuration", 503);
  }
  get dimensions() {
    return this.http.connection.dimensions!;
  }
  fingerprint() {
    return connectionFingerprint(this.http.connection) + "/chunks-v1";
  }
  async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
    if (!texts.length || texts.length > 16) throw new SearchError("invalidInput");
    const c = this.http.connection;
    const result = await this.http.request(
      c.kind === "ollama" ? "/api/embed" : "/embeddings",
      "POST",
      c.kind === "ollama"
        ? { model: c.model, input: texts, truncate: false }
        : { model: c.model, input: texts, encoding_format: "float" },
      signal,
    );
    const data =
      c.kind === "ollama"
        ? result.embeddings
        : Array.isArray(result.data)
          ? [...result.data].sort((a, b) => Number(a.index) - Number(b.index)).map((x) => x.embedding)
          : null;
    if (
      !Array.isArray(data) ||
      data.length !== texts.length ||
      data.some(
        (v) =>
          !Array.isArray(v) ||
          v.length !== this.dimensions ||
          v.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
          !v.some((n) => n !== 0),
      )
    )
      throw new SearchError("configuration", 503);
    if (c.kind === "openai") {
      const indices = (result.data as { index: unknown }[]).map((item) => item.index);
      if (
        indices.some((n) => !Number.isSafeInteger(n) || Number(n) < 0 || Number(n) >= texts.length) ||
        new Set(indices).size !== texts.length
      )
        throw new SearchError("configuration", 503);
    }
    try {
      return data.map((v) => float32Vector(v, this.dimensions));
    } catch {
      throw new SearchError("configuration", 503);
    }
  }
  async health() {
    const c = this.http.connection;
    if (c.kind === "ollama") {
      const result = await this.http.request("/api/tags");
      const normalize = (name: string) => (name.includes(":") ? name : name + ":latest");
      if (
        !Array.isArray(result.models) ||
        !result.models.some((value: unknown) => {
          if (!value || typeof value !== "object") return false;
          const model = value as { name?: unknown; model?: unknown };
          return [model.name, model.model].some(
            (name) => typeof name === "string" && normalize(name) === normalize(c.model!),
          );
        })
      )
        throw new SearchError("configuration", 503);
    } else {
      const result = await this.http.request("/models/" + encodeURIComponent(c.model!));
      if (result.id !== c.model) throw new SearchError("configuration", 503);
    }
    return true;
  }
}
