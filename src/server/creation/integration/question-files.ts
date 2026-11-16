import { createHash } from "node:crypto";
import { join } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import type { ApplicationQuestionAnswers } from "../../../shared/engine/application-tools.js";
import type { CreationAnswerContent, CreationQuestionContent, CreationQuestionFiles } from "../questions/contracts.js";
import { creationQuestions } from "../questions/validation.js";
import { creationInteger, creationRecord, creationText, creationUuid } from "../validation.js";
import { CreationError } from "../contracts.js";

function question(value: unknown): CreationQuestionContent {
  const row = creationRecord(value, ["schema", "owner", "taskId", "generation", "questions"]);
  if (row.schema !== 1) throw new CreationError("invalidInput");
  return {
    schema: 1,
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    generation: creationInteger(row.generation),
    questions: creationQuestions(row.questions),
  };
}
function answer(value: unknown): CreationAnswerContent {
  const row = creationRecord(value, ["schema", "owner", "taskId", "questionId", "answers"]);
  if (row.schema !== 1 || !row.answers || typeof row.answers !== "object" || Array.isArray(row.answers))
    throw new CreationError("invalidInput");
  const input = creationRecord(row.answers, Object.keys(row.answers)),
    answers: ApplicationQuestionAnswers = Object.create(null);
  if (Object.keys(input).length > 8) throw new CreationError("invalidInput");
  for (const [key, value] of Object.entries(input)) {
    const entry = creationRecord(value, ["answers"]);
    if (
      !Array.isArray(entry.answers) ||
      entry.answers.length !== 1 ||
      typeof entry.answers[0] !== "string" ||
      !entry.answers[0].trim() ||
      Buffer.byteLength(entry.answers[0]) > 65536
    )
      throw new CreationError("invalidInput");
    answers[key] = { answers: [entry.answers[0]] };
  }
  return {
    schema: 1,
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    questionId: creationUuid(row.questionId),
    answers,
  };
}
const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
function store<T>(root: string, decode: (value: unknown) => T) {
  return new FilePackageContent<T>(root, {
    maxBytes: 128 * 1024,
    encode: async (value: T) => Buffer.from(stableJson(decode(value))),
    decode: async (bytes: Uint8Array) => decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    digest: hash,
  });
}
/** Questions and answers are private task input files, not document bodies or native approval records. */
export class FileCreationQuestions implements CreationQuestionFiles {
  private questions: FilePackageContent<CreationQuestionContent>;
  private answers: FilePackageContent<CreationAnswerContent>;
  constructor(root: string) {
    this.questions = store(join(root, "questions"), question);
    this.answers = store(join(root, "answers"), answer);
  }
  async putQuestion(value: CreationQuestionContent) {
    const input = question(value);
    await this.questions.put(input);
    return hash(input);
  }
  question(digest: string) {
    return this.questions.read(digest);
  }
  async putAnswer(value: CreationAnswerContent) {
    const input = answer(value);
    await this.answers.put(input);
    return hash(input);
  }
  answer(digest: string) {
    return this.answers.read(digest);
  }
}
