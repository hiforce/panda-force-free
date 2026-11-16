import { engineQuestions, validateQuestionAnswers } from "../../../shared/engine/questions.js";
import type { ApplicationQuestionAnswers } from "../../../shared/engine/application-tools.js";
import { CreationError } from "../contracts.js";

export function creationQuestions(value: unknown) {
  const questions = engineQuestions(value);
  if (
    questions.length > 8 ||
    Buffer.byteLength(JSON.stringify(questions)) > 32768 ||
    questions.some((question) => question.isSecret)
  )
    throw new CreationError("invalidInput");
  return questions;
}
export function creationAnswers(
  questions: ReturnType<typeof creationQuestions>,
  value: unknown,
): ApplicationQuestionAnswers {
  validateQuestionAnswers(questions, value);
  const checked = value as { answers: ApplicationQuestionAnswers };
  if (Buffer.byteLength(JSON.stringify(checked.answers)) > 65536) throw new CreationError("invalidInput");
  return structuredClone(checked.answers);
}
