import type { SavedSourceKind } from "../content-sources/contracts.js";
import { selectedSourceKinds } from "../content-sources/selection.js";
import { knowledgeObject, knowledgeText, knowledgeId } from "./primitives.js";
export { knowledgeObject, knowledgeText, knowledgeId, knowledgeDigest } from "./primitives.js";
import { KnowledgeError } from "./contracts.js";
import { KNOWLEDGE_LIMITS, type KnowledgeDialogue, type KnowledgeSelection } from "./tasks.js";

export function knowledgeSelection(value: unknown): KnowledgeSelection {
  const p = knowledgeObject(value, ["project", "ids", "contentKinds"]);
  if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > KNOWLEDGE_LIMITS.sources)
    throw new KnowledgeError("invalidInput");
  const ids = p.ids.map(knowledgeId).sort();
  if (new Set(ids).size !== ids.length) throw new KnowledgeError("invalidInput");
  let contentKinds: SavedSourceKind[] | undefined;
  if (p.contentKinds !== undefined) {
    const kinds = selectedSourceKinds(p.contentKinds);
    if (!kinds) throw new KnowledgeError("invalidInput");
    contentKinds = kinds;
  }
  return { project: knowledgeId(p.project), ids, ...(contentKinds ? { contentKinds } : {}) };
}
export function knowledgeDialogue(value: unknown): KnowledgeDialogue {
  const p = knowledgeObject(value, ["questions", "answers"]);
  if (
    !Array.isArray(p.questions) ||
    !Array.isArray(p.answers) ||
    p.questions.length > KNOWLEDGE_LIMITS.rounds * KNOWLEDGE_LIMITS.questionCount ||
    p.answers.length > p.questions.length
  )
    throw new KnowledgeError("invalidInput");
  const ids = new Set<string>();
  const questions = p.questions.map((value) => {
    const q = knowledgeObject(value, ["id", "question", "options"]),
      id = knowledgeId(q.id);
    if (ids.has(id) || !Array.isArray(q.options) || q.options.length > 3) throw new KnowledgeError("invalidInput");
    ids.add(id);
    return {
      id,
      question: knowledgeText(q.question, 2000),
      options: q.options.map((option) => knowledgeText(option, 200)),
    };
  });
  const answered = new Set<string>();
  const answers = p.answers.map((value) => {
    const a = knowledgeObject(value, ["questionId", "answer"]),
      questionId = knowledgeId(a.questionId);
    if (!ids.has(questionId) || answered.has(questionId)) throw new KnowledgeError("invalidInput");
    answered.add(questionId);
    return { questionId, answer: knowledgeText(a.answer, 4000) };
  });
  const result = { questions, answers };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 128 * 1024) throw new KnowledgeError("invalidInput");
  return result;
}
