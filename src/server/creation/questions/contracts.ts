import type { CreationResult } from "../ports.js";
import type { EngineQuestion } from "../../../shared/engine/questions.js";
import type { ApplicationQuestionAnswers } from "../../../shared/engine/application-tools.js";
import type { CreationExecution, CreationTask } from "../contracts.js";

export const CREATION_CLARIFICATION_BYTES = 128 * 1024;
export interface CreationClarification {
  questions: EngineQuestion[];
  answers: ApplicationQuestionAnswers;
}

export interface CreationQuestionContent {
  schema: 1;
  taskId: string;
  owner: string;
  generation: number;
  questions: EngineQuestion[];
}
export interface CreationAnswerContent {
  schema: 1;
  questionId: string;
  taskId: string;
  owner: string;
  answers: ApplicationQuestionAnswers;
}
export interface CreationQuestionRecord {
  id: string;
  taskId: string;
  owner: string;
  generation: number;
  questionDigest: string;
  answerDigest: string | null;
  state: "pending" | "answered" | "expired";
  createdAt: number;
  answeredAt: number | null;
}
export interface CreationQuestionFiles {
  putQuestion(value: CreationQuestionContent): Promise<string>;
  question(digest: string): Promise<CreationQuestionContent>;
  putAnswer(value: CreationAnswerContent): Promise<string>;
  answer(digest: string): Promise<CreationAnswerContent>;
}
export interface CreationQuestionStore {
  task(owner: string, id: string): CreationResult<CreationTask>;
  assert(scope: CreationExecution, now: number): CreationResult<void>;
  register(scope: CreationExecution, digest: string, now: number): CreationResult<CreationQuestionRecord>;
  get(owner: string, id: string): CreationResult<CreationQuestionRecord>;
  pending(owner: string, taskId: string): CreationResult<CreationQuestionRecord | null>;
  answer(owner: string, questionId: string, digest: string, now: number): CreationResult<CreationQuestionRecord>;
  answered(owner: string, taskId: string): CreationResult<CreationQuestionRecord[]>;
}
