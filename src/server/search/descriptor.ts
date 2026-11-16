import { searchId, searchRecord, searchText } from "../../shared/search/validation.js";
import type { IndexReference } from "./ports.js";
import type { ActiveSearchIndex } from "./state.js";

const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function reference(value: unknown, provider: string): IndexReference | null {
  if (value === null) return null;
  const p = searchRecord(value, ["name", "provider", "integrity"]);
  if (!digest(p.name) || p.provider !== provider) throw Error("Invalid index reference");
  if (p.integrity !== undefined) {
    const i = searchRecord(p.integrity, ["schema", "format", "digest", "count", "recipe", "pageSize", "checkpoint"]);
    const format = { local: "local-json/1", elasticsearch: "es-documents/1", milvus: "milvus-seal/1" }[provider];
    if (
      i.schema !== 1 ||
      i.format !== format ||
      !digest(i.digest) ||
      typeof i.count !== "number" ||
      !Number.isSafeInteger(i.count) ||
      i.count < 0 ||
      (i.pageSize !== undefined && (!positive(i.pageSize) || Number(i.pageSize) > 10000))
    )
      throw Error("Invalid index integrity");
    searchText(i.recipe, 1024);
    if (i.checkpoint !== undefined) searchText(i.checkpoint, 1024);
  }
  return value as IndexReference;
}
/** Persisted descriptors are derived input, never trusted casts or permission to delete arbitrary provider resources. */
export function decodeSearchIndex(raw: string, source?: string): ActiveSearchIndex | null {
  try {
    if (Buffer.byteLength(raw) > 65536) return null;
    const p = searchRecord(JSON.parse(raw), [
      "text",
      "vector",
      "analyzer",
      "source",
      "sourceRevision",
      "settingsRevision",
      "embedding",
      "textFingerprint",
      "knowledgeCommit",
      "vectorInput",
      "invalidated",
    ]);
    const s = searchRecord(p.source, ["id", "name", "kind", "connection", "knowledge", "enabled", "revision"]);
    const id = searchId(s.id);
    if (
      (source !== undefined && id !== source) ||
      !["local", "elasticsearch"].includes(String(s.kind)) ||
      typeof s.enabled !== "boolean" ||
      !positive(s.revision) ||
      !positive(p.sourceRevision) ||
      s.revision !== p.sourceRevision ||
      !positive(p.settingsRevision) ||
      (p.invalidated !== undefined && typeof p.invalidated !== "boolean")
    )
      return null;
    searchText(s.name, 120);
    if (s.connection !== null) searchId(s.connection);
    if (s.knowledge !== null) searchId(s.knowledge);
    if ((s.kind === "local" && s.connection !== null) || (s.kind === "elasticsearch" && s.connection === null))
      return null;
    searchText(p.analyzer, 180);
    for (const field of ["embedding", "textFingerprint"]) if (p[field] !== null) searchText(p[field], 1024);
    for (const field of ["knowledgeCommit", "vectorInput"]) if (p[field] !== undefined) searchText(p[field], 1024);
    reference(p.text, String(s.kind));
    reference(p.vector, "milvus");
    return p as unknown as ActiveSearchIndex;
  } catch {
    return null;
  }
}
