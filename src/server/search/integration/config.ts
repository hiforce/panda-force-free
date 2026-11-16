import { readFileSync, statSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchRecord, searchId, searchText } from "../../../shared/search/validation.js";
import type { SearchConnection, KnowledgeConnection } from "../connection.js";
import { embeddingPolicy, type EmbeddingPolicy } from "../embeddings/policy.js";
export interface SearchConfiguration {
  connections: SearchConnection[];
  knowledge: KnowledgeConnection[];
  administrators: string[];
  path: string;
  embedding: EmbeddingPolicy;
}
export function searchConfiguration(root: string, env: NodeJS.ProcessEnv = process.env): SearchConfiguration {
  const path = env.PANDA_FORCE_SEARCH_CONFIG_FILE || join(root, "config", "search.json");
  if (!existsSync(path))
    return { path, connections: [], knowledge: [], administrators: [], embedding: embeddingPolicy() };
  if (statSync(path).size > 128 * 1024) throw new SearchError("configuration", 503);
  const p = searchRecord(JSON.parse(readFileSync(path, "utf8")), [
    "schema",
    "connections",
    "knowledge",
    "administrators",
    "embedding",
  ]);
  if (
    p.schema !== 1 ||
    !Array.isArray(p.connections) ||
    p.connections.length > 32 ||
    !Array.isArray(p.knowledge) ||
    p.knowledge.length > 16 ||
    !Array.isArray(p.administrators)
  )
    throw new SearchError("configuration", 503);
  const connections = p.connections.map((value) => {
    const v = searchRecord(value, [
      "id",
      "kind",
      "url",
      "username",
      "passwordFile",
      "apiKeyFile",
      "caFile",
      "model",
      "dimensions",
      "prefix",
    ]);
    if (!["elasticsearch", "milvus", "ollama", "openai"].includes(String(v.kind)))
      throw new SearchError("configuration");
    const url = new URL(searchText(v.url, 2000));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new SearchError("configuration");
    const c: SearchConnection = {
      id: searchId(v.id),
      kind: v.kind as SearchConnection["kind"],
      url: url.href.replace(/\/$/, ""),
    };
    for (const k of ["username", "passwordFile", "apiKeyFile", "caFile", "model", "prefix"] as const)
      if (v[k] !== undefined) c[k] = searchText(v[k], 2000);
    for (const k of ["passwordFile", "apiKeyFile", "caFile"] as const)
      if (c[k] && !isAbsolute(c[k]!)) throw new SearchError("configuration");
    if (v.dimensions !== undefined) {
      if (!Number.isSafeInteger(v.dimensions) || Number(v.dimensions) < 1 || Number(v.dimensions) > 65536)
        throw new SearchError("configuration");
      c.dimensions = Number(v.dimensions);
    }
    if (c.prefix && !/^[a-z][a-z0-9_]{0,24}$/.test(c.prefix)) throw new SearchError("configuration");
    if (c.passwordFile && !c.username) throw new SearchError("configuration");
    return c;
  });
  if (new Set(connections.map((x) => x.id)).size !== connections.length) throw new SearchError("configuration");
  const knowledge = p.knowledge.map((value) => {
    const v = searchRecord(value, ["id", "vectors", "embeddings"]);
    return { id: searchId(v.id), vectors: searchId(v.vectors), embeddings: searchId(v.embeddings) };
  });
  for (const k of knowledge)
    if (
      connections.find((x) => x.id === k.vectors)?.kind !== "milvus" ||
      !["ollama", "openai"].includes(connections.find((x) => x.id === k.embeddings)?.kind || "")
    )
      throw new SearchError("configuration");
  return {
    path,
    connections,
    knowledge,
    administrators: p.administrators.map((x) => searchText(x, 300)),
    embedding: embeddingPolicy(p.embedding),
  };
}
