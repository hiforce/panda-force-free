import { knowledgeSourceBinding } from "../../../shared/knowledge/source-binding.js";
import { createHash } from "node:crypto";
import type { KnowledgeEvidenceSource } from "../../../shared/knowledge/contracts.js";
import type { KnowledgeTaskInput, KnowledgeDialogue } from "../../../shared/knowledge/tasks.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import {
  knowledgeId,
  knowledgeObject,
  knowledgeSelection,
  knowledgeText,
  knowledgeDigest,
} from "../../../shared/knowledge/task-validation.js";
import { KnowledgeError } from "../../../shared/knowledge/contracts.js";

/** Snapshots contain only explicitly selected saved assets. User answers are added separately as literal evidence. */
export function knowledgeInput(value: unknown): KnowledgeTaskInput {
  const p = knowledgeObject(value, ["schema", "scope", "purpose", "sources", "sourceCommit", "profile", "target"]),
    scope = knowledgeSelection(p.scope),
    profile = knowledgeObject(p.profile, ["id", "engineId", "model", "activeTimeoutMs"]),
    target = knowledgeObject(p.target, ["id", "expectedVersion", "previous"]);
  let previous: KnowledgeTaskInput["target"]["previous"];
  if (target.previous !== undefined) {
    const ref = knowledgeObject(target.previous, ["digest", "state", "reviewRequired"]);
    if (typeof ref.reviewRequired !== "boolean") throw new KnowledgeError("invalidInput");
    previous = {
      digest: knowledgeDigest(ref.digest),
      state: knowledgeDigest(ref.state),
      reviewRequired: ref.reviewRequired,
    };
  }
  if (
    p.schema !== 1 ||
    !Array.isArray(p.sources) ||
    p.sources.length !== scope.ids.length ||
    !Number.isSafeInteger(profile.activeTimeoutMs) ||
    Number(profile.activeTimeoutMs) < 1000 ||
    Number(profile.activeTimeoutMs) > 600000
  )
    throw new KnowledgeError("invalidInput");
  const seen = new Set<string>();
  const sources: KnowledgeEvidenceSource[] = p.sources.map((value) => {
    const s = knowledgeObject(value, ["id", "version", "kind", "title", "text", "sections", "binding"]),
      id = knowledgeId(s.id),
      text = knowledgeText(s.text, KNOWLEDGE_LIMITS.sourceBytes, true);
    if (
      s.kind !== "asset" ||
      !scope.ids.includes(id) ||
      seen.has(id) ||
      !Array.isArray(s.sections) ||
      s.sections.length > 1000
    )
      throw new KnowledgeError("invalidInput");
    seen.add(id);
    const binding = s.binding === undefined ? undefined : knowledgeSourceBinding(s.binding, id);
    if (binding && !(scope.contentKinds ?? ["document"]).includes(binding.kind))
      throw new KnowledgeError("invalidInput");
    if (!binding && !(scope.contentKinds ?? ["document"]).includes("document"))
      throw new KnowledgeError("invalidInput");
    const sections = new Set<string>();
    return {
      id,
      version: knowledgeText(s.version, 160),
      kind: "asset",
      ...(binding ? { binding } : {}),
      title: knowledgeText(s.title, 2000),
      text,
      sections: s.sections.map((value) => {
        const section = knowledgeObject(value, ["id", "start", "end"]),
          id = knowledgeText(section.id, 160);
        if (
          sections.has(id) ||
          !Number.isSafeInteger(section.start) ||
          !Number.isSafeInteger(section.end) ||
          Number(section.start) < 0 ||
          Number(section.end) < Number(section.start) ||
          Number(section.end) > text.length
        )
          throw new KnowledgeError("invalidInput");
        sections.add(id);
        return { id, start: Number(section.start), end: Number(section.end) };
      }),
    };
  });
  if (sources.reduce((size, source) => size + Buffer.byteLength(source.text), 0) > KNOWLEDGE_LIMITS.sourceBytes)
    throw new KnowledgeError("invalidInput");
  return {
    schema: 1,
    scope,
    purpose: knowledgeText(p.purpose, KNOWLEDGE_LIMITS.purposeBytes, true),
    sources,
    sourceCommit: knowledgeText(p.sourceCommit, 160),
    profile: {
      id: knowledgeId(profile.id),
      engineId: knowledgeId(profile.engineId),
      model: knowledgeText(profile.model, 128),
      activeTimeoutMs: Number(profile.activeTimeoutMs),
    },
    target: {
      id: knowledgeId(target.id),
      expectedVersion: target.expectedVersion === null ? null : knowledgeText(target.expectedVersion, 160),
      ...(previous ? { previous } : {}),
    },
  };
}

export function knowledgeContext(input: KnowledgeTaskInput, dialogue: KnowledgeDialogue): KnowledgeEvidenceSource[] {
  return [
    ...input.sources,
    ...dialogue.answers.map((answer): KnowledgeEvidenceSource => ({
      id: "user-" + answer.questionId,
      version: createHash("sha256").update(answer.answer).digest("hex"),
      kind: "user-input",
      title: dialogue.questions.find((question) => question.id === answer.questionId)!.question,
      text: answer.answer,
      sections: [],
    })),
  ];
}
