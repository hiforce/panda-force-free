import type { SavedSourceBinding } from "../content-sources/contracts.js";
import { knowledgeSourceBinding } from "./source-binding.js";
import { knowledgeDigest, knowledgeId, knowledgeObject, knowledgeText } from "./task-validation.js";
import { KNOWLEDGE_LIMITS } from "./tasks.js";
import { KnowledgeError } from "./contracts.js";
import type { KnowledgeReceipt, KnowledgeRecord } from "./tasks.js";
const blob = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new KnowledgeError("invalidInput");
  return value;
};
export function admittedKnowledgeReceipt(value: unknown): KnowledgeReceipt {
  const p = knowledgeObject(value, ["id", "version", "commit"]);
  return { id: knowledgeId(p.id), version: knowledgeDigest(p.version), commit: blob(p.commit) };
}
export function knowledgeCatalogProjection(value: unknown): KnowledgeCatalogProjection {
  const p = knowledgeObject(value, [
    "schema",
    "id",
    "version",
    "taskId",
    "sourceCommit",
    "recordBlob",
    "markdownBlob",
    "sources",
  ]);
  if (p.schema !== 1 || !Array.isArray(p.sources) || !p.sources.length || p.sources.length > KNOWLEDGE_LIMITS.sources)
    throw new KnowledgeError("invalidInput");
  const sources = p.sources.map((value) => {
    const source = knowledgeObject(value, ["id", "version", "blob", "binding"]),
      id = knowledgeId(source.id),
      binding = source.binding === undefined ? undefined : knowledgeSourceBinding(source.binding, id);
    if (binding && binding.blob !== source.blob) throw new KnowledgeError("invalidInput");
    return {
      id,
      version: knowledgeText(source.version, 160),
      blob: blob(source.blob),
      ...(binding ? { binding } : {}),
    };
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new KnowledgeError("invalidInput");
  return {
    schema: 1,
    id: knowledgeId(p.id),
    version: knowledgeDigest(p.version),
    taskId: knowledgeId(p.taskId),
    sourceCommit: blob(p.sourceCommit),
    recordBlob: blob(p.recordBlob),
    markdownBlob: blob(p.markdownBlob),
    sources,
  };
}

/** Derived metadata contains identities and saved-file bindings, never knowledge or document text. */
export interface KnowledgeCatalogProjection {
  schema: 1;
  id: string;
  version: string;
  taskId: string;
  sourceCommit: string;
  recordBlob: string;
  markdownBlob: string;
  sources: { id: string; version: string; blob: string; binding?: SavedSourceBinding }[];
}
export interface KnowledgeAdmission {
  taskId: string;
  owner: string;
  project: string;
  outputDigest: string;
  inputDigest: string;
  receipt: KnowledgeReceipt;
}
export interface KnowledgeCatalogEntry extends KnowledgeAdmission {
  projection: KnowledgeCatalogProjection;
}
export interface KnowledgeReadScope {
  owner: string;
  project: string;
}
export interface KnowledgeReadDetail {
  record: KnowledgeRecord;
  receipt: KnowledgeReceipt;
}
export interface ApprovedKnowledgeValue extends KnowledgeReadDetail {
  sources: (KnowledgeCatalogProjection["sources"][number] & { title: string; path: string; ancestors: string[] })[];
}
