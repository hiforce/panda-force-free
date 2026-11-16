import type { EngineQuestion } from "../../../shared/engine/questions.js";
import type { CreationExecution } from "../contracts.js";
import { CreationError } from "../contracts.js";
import { creationAnswers, creationQuestions } from "./validation.js";
import { CREATION_CLARIFICATION_BYTES, type CreationClarification } from "./contracts.js";
import type { CreationQuestionFiles, CreationQuestionRecord, CreationQuestionStore } from "./contracts.js";

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      },
      timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 300);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** Task questions have their own files, authority and durable answer identity; no conversation UI registry is shared. */
export class CreationQuestions {
  constructor(
    private readonly store: CreationQuestionStore,
    private readonly files: CreationQuestionFiles,
    private readonly authorize: (owner: string, projectId: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}
  private async content(record: CreationQuestionRecord) {
    const content = await this.files.question(record.questionDigest);
    if (content.taskId !== record.taskId || content.owner !== record.owner || content.generation !== record.generation)
      throw new CreationError("unavailable");
    return content;
  }
  async pending(owner: string, taskId: string) {
    const task = await this.store.task(owner, taskId);
    await this.authorize(owner, task.spec.projectId);
    const record = await this.store.pending(owner, taskId);
    if (!record || !["queued", "running"].includes(task.state) || task.cancelRequested || task.artifact) return null;
    return { id: record.id, generation: record.generation, questions: (await this.content(record)).questions };
  }
  async ask(value: CreationExecution, input: readonly EngineQuestion[], signal: AbortSignal) {
    const scope = { ...value },
      task = await this.store.task(scope.owner, scope.taskId);
    signal.throwIfAborted();
    await this.authorize(scope.owner, task.spec.projectId);
    await this.store.assert(scope, this.now());
    const questions = creationQuestions(input),
      history = await this.history(scope.owner, scope.taskId);
    // Reserve a complete answer before accepting another question, so its owner is never trapped at the limit.
    if (Buffer.byteLength(JSON.stringify([...history, { questions }])) + 65568 > CREATION_CLARIFICATION_BYTES)
      throw new CreationError("invalidInput");
    const digest = await this.files.putQuestion({
        schema: 1,
        taskId: scope.taskId,
        owner: scope.owner,
        generation: scope.generation,
        questions,
      }),
      record = await this.store.register(scope, digest, this.now());
    for (;;) {
      signal.throwIfAborted();
      await this.store.assert(scope, this.now());
      const current = await this.store.get(scope.owner, record.id);
      if (current.state === "expired") throw new CreationError("leaseLost");
      if (current.state === "answered" && current.answerDigest) {
        const answer = await this.files.answer(current.answerDigest);
        if (answer.owner !== scope.owner || answer.taskId !== scope.taskId || answer.questionId !== record.id)
          throw new CreationError("unavailable");
        await this.authorize(scope.owner, task.spec.projectId);
        await this.store.assert(scope, this.now());
        return creationAnswers(questions, { answers: answer.answers });
      }
      await pause(signal);
    }
  }
  async answer(owner: string, id: string, value: unknown) {
    const record = await this.store.get(owner, id),
      task = await this.store.task(owner, record.taskId);
    await this.authorize(owner, task.spec.projectId);
    const questions = (await this.content(record)).questions,
      answers = creationAnswers(questions, value),
      digest = await this.files.putAnswer({ schema: 1, taskId: record.taskId, owner, questionId: id, answers });
    await this.authorize(owner, task.spec.projectId);
    return this.store.answer(owner, id, digest, this.now());
  }
  async history(owner: string, taskId: string) {
    const task = await this.store.task(owner, taskId);
    await this.authorize(owner, task.spec.projectId);
    const result: CreationClarification[] = [];
    for (const record of await this.store.answered(owner, taskId)) {
      const question = await this.content(record),
        answer = await this.files.answer(record.answerDigest!);
      if (answer.questionId !== record.id || answer.taskId !== taskId || answer.owner !== owner)
        throw new CreationError("unavailable");
      result.push({
        questions: question.questions,
        answers: creationAnswers(question.questions, { answers: answer.answers }),
      });
    }
    return result;
  }
}
