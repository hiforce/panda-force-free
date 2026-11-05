import { isRecord } from "../records.js";
export interface EngineQuestion {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  isOther?: boolean;
  isSecret?: boolean;
}
export function engineQuestions(value: unknown): EngineQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("Invalid engine questionnaire");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      seen.has(entry.id) ||
      typeof entry.question !== "string"
    )
      throw new Error("Invalid engine question");
    seen.add(entry.id);
    const question: EngineQuestion = { id: entry.id, question: entry.question };
    if (typeof entry.header === "string") question.header = entry.header;
    if (typeof entry.isOther === "boolean") question.isOther = entry.isOther;
    if (typeof entry.isSecret === "boolean") question.isSecret = entry.isSecret;
    if (entry.options !== undefined) {
      if (!Array.isArray(entry.options) || entry.options.length > 100)
        throw new Error("Invalid engine question options");
      question.options = entry.options.map((option) => {
        if (!isRecord(option) || typeof option.label !== "string") throw new Error("Invalid engine question option");
        return {
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        };
      });
    }
    return question;
  });
}
export function validateQuestionAnswers(questions: readonly EngineQuestion[], result: unknown): void {
  if (!isRecord(result) || !isRecord(result.answers)) throw new Error("Invalid questionnaire answers");
  const answers = result.answers;
  if (Object.keys(answers).length !== questions.length) throw new Error("Answer every displayed question");
  for (const question of questions) {
    const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
    if (
      !isRecord(answer) ||
      !Array.isArray(answer.answers) ||
      answer.answers.length !== 1 ||
      typeof answer.answers[0] !== "string" ||
      !answer.answers[0].trim()
    )
      throw new Error("Invalid questionnaire answer");
    const selected = answer.answers[0];
    if (question.options?.length && !question.isOther && !question.options.some((option) => option.label === selected))
      throw new Error("Choose a displayed question option");
  }
}
