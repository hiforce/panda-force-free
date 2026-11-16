import { isRecord } from "../records.js";
import {
  KnowledgeError,
  type KnowledgeDraftInput,
  type KnowledgeEvidenceInput,
  type KnowledgeClaimKind,
} from "./contracts.js";

function object(value: unknown, keys: string[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new KnowledgeError("invalidInput");
  return value;
}
function text(value: unknown, max: number, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()))
    throw new KnowledgeError("invalidInput");
  return value;
}
function identity(value: unknown) {
  const id = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new KnowledgeError("invalidInput");
  return id;
}
function evidence(value: unknown): KnowledgeEvidenceInput {
  const p = object(value, ["sourceId", "version", "quote", "section", "start"]);
  if (p.start !== undefined && (!Number.isSafeInteger(p.start) || Number(p.start) < 0))
    throw new KnowledgeError("invalidInput");
  return {
    sourceId: identity(p.sourceId),
    version: text(p.version, 160),
    quote: text(p.quote, 4000),
    ...(p.section === undefined ? {} : { section: text(p.section, 160) }),
    ...(p.start === undefined ? {} : { start: Number(p.start) }),
  };
}

/** Model and user drafts share a closed data format; neither can select files, tools or execution settings. */
export function knowledgeDraft(value: unknown): KnowledgeDraftInput {
  const p = object(value, ["schema", "title", "summary", "claims", "uncertainties"]);
  if (
    p.schema !== 1 ||
    !Array.isArray(p.claims) ||
    !p.claims.length ||
    p.claims.length > 64 ||
    !Array.isArray(p.uncertainties) ||
    p.uncertainties.length > 32
  )
    throw new KnowledgeError("invalidInput");
  const ids = new Set<string>();
  const claims = p.claims.map((value) => {
    const c = object(value, ["id", "kind", "text", "evidence"]),
      id = identity(c.id);
    if (
      ids.has(id) ||
      typeof c.kind !== "string" ||
      !["source", "inference", "user"].includes(c.kind) ||
      !Array.isArray(c.evidence) ||
      c.evidence.length > 16
    )
      throw new KnowledgeError("invalidInput");
    ids.add(id);
    return {
      id,
      kind: c.kind as KnowledgeClaimKind,
      text: text(c.text, 8000),
      evidence: c.evidence.map(evidence),
    };
  });
  const draft: KnowledgeDraftInput = {
    schema: 1,
    title: text(p.title, 300),
    summary: text(p.summary, 16000, true),
    claims,
    uncertainties: p.uncertainties.map((v) => text(v, 2000)),
  };
  if (JSON.stringify(draft).length > 512000) throw new KnowledgeError("invalidInput");
  return draft;
}
