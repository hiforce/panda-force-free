import { createHash } from "node:crypto";
import {
  KnowledgeError,
  type KnowledgeDraft,
  type KnowledgeEvidence,
  type KnowledgeEvidenceInput,
  type KnowledgeEvidenceSource,
} from "../../shared/knowledge/contracts.js";
import { knowledgeDraft } from "../../shared/knowledge/validation.js";
import { KNOWLEDGE_LIMITS } from "../../shared/knowledge/tasks.js";

type EvidenceContext = KnowledgeEvidenceSource & { digest: string };

function sourceIndex(sources: readonly KnowledgeEvidenceSource[]) {
  if (sources.length > 64 || sources.reduce((n, s) => n + s.text.length, 0) > KNOWLEDGE_LIMITS.contextCharacters)
    throw new KnowledgeError("invalidInput");
  const index = new Map<string, EvidenceContext>();
  for (const source of sources) {
    if (index.has(source.id) || !["asset", "user-input"].includes(source.kind))
      throw new KnowledgeError("invalidEvidence");
    const sections = new Set<string>();
    for (const section of source.sections) {
      if (
        sections.has(section.id) ||
        !Number.isSafeInteger(section.start) ||
        !Number.isSafeInteger(section.end) ||
        section.start < 0 ||
        section.end < section.start ||
        section.end > source.text.length
      )
        throw new KnowledgeError("invalidEvidence");
      sections.add(section.id);
    }
    index.set(source.id, { ...source, digest: createHash("sha256").update(source.text).digest("hex") });
  }
  return index;
}

function resolve(input: KnowledgeEvidenceInput, sources: Map<string, EvidenceContext>): KnowledgeEvidence {
  const source = sources.get(input.sourceId);
  if (!source) throw new KnowledgeError("invalidEvidence");
  if (source.version !== input.version) throw new KnowledgeError("sourceChanged", 409);
  const section = input.section === undefined ? null : source.sections.find((s) => s.id === input.section);
  if (input.section !== undefined && !section) throw new KnowledgeError("invalidEvidence");
  const from = section?.start ?? 0,
    to = section?.end ?? source.text.length,
    start = input.start ?? source.text.indexOf(input.quote, from),
    end = start + input.quote.length;
  if (start < from || end > to || source.text.slice(start, end) !== input.quote)
    throw new KnowledgeError("invalidEvidence");
  if (input.start === undefined) {
    const next = source.text.indexOf(input.quote, start + 1);
    if (next >= 0 && next + input.quote.length <= to) throw new KnowledgeError("ambiguousEvidence");
  }
  return {
    sourceId: source.id,
    version: source.version,
    kind: source.kind,
    digest: source.digest,
    start,
    end,
    quote: input.quote,
    ...(input.section === undefined ? {} : { section: input.section }),
  };
}

/** Only the caller's selected immutable context can establish provenance; offsets are derived and checked here. */
export function validateKnowledgeEvidence(value: unknown, sources: readonly KnowledgeEvidenceSource[]): KnowledgeDraft {
  const draft = knowledgeDraft(value),
    index = sourceIndex(sources);
  return {
    ...draft,
    claims: draft.claims.map((claim) => {
      const evidence = claim.evidence.map((input) => resolve(input, index));
      if (
        (claim.kind === "source" && (!evidence.length || evidence.some((e) => e.kind !== "asset"))) ||
        (claim.kind === "user" && (!evidence.length || evidence.some((e) => e.kind !== "user-input")))
      )
        throw new KnowledgeError("invalidEvidence");
      return { ...claim, evidence };
    }),
  };
}
