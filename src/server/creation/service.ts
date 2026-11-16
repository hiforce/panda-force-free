import type { CreationResult } from "./ports.js";
import type { CreationAvailability, CreationTaskView } from "../../shared/creation/contracts.js";
import type { CreationInputs } from "./input.js";
import type { CreationTask } from "./contracts.js";
import type { CreationSubmissions } from "./submissions.js";
import type { CreationQuestions } from "./questions/service.js";
import { CreationError } from "./contracts.js";
import { creationId, creationUuid } from "./validation.js";
import type { CreationProgressStore } from "./ports.js";
import type { CreationTaskDetail } from "../../shared/creation/contracts.js";

export interface CreationManagement {
  get(owner: string, id: string): CreationResult<CreationTask>;
  cancel(owner: string, id: string, now: number): CreationResult<CreationTask>;
}
export interface CreationHistory {
  list(owner: string, projectId?: string): CreationResult<CreationTask[]>;
  retry(owner: string, id: string, operationId: string, now: number): CreationResult<CreationTask>;
}
/** HTTP and future command adapters use the same authorized task operations; internal leases never become browser state. */
export class CreationService {
  private closed = false;
  private readonly summaries = new Map<string, Promise<{ prompt: string; model: string | null }>>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly tasks: CreationManagement,
    private readonly history: CreationHistory,
    private readonly submissions: CreationSubmissions,
    private readonly inputs: CreationInputs,
    private readonly questions: CreationQuestions,
    private readonly authorize: (owner: string, projectId: string) => Promise<void>,
    private readonly availability: () => Promise<CreationAvailability>,
    private readonly runtime: { wake(): CreationResult<void>; interrupt(owner: string, id: string): void },
    private readonly now: () => number = Date.now,
    private readonly progress?: CreationProgressStore,
  ) {}
  private using<T>(work: () => Promise<T>) {
    if (this.closed) return Promise.reject(new CreationError("unavailable"));
    const result = Promise.resolve().then(work);
    this.pending.add(result);
    return result.finally(() => this.pending.delete(result));
  }
  options() {
    return this.using(this.availability);
  }
  private async view(owner: string, task: CreationTask): Promise<CreationTaskView> {
    await this.authorize(owner, task.spec.projectId);
    const cacheKey = JSON.stringify([owner, task.spec.inputDigest]);
    let summary = this.summaries.get(cacheKey);
    if (!summary) {
      summary = this.inputs
        .read(task.spec)
        .then((input) => ({ prompt: input.prompt, model: input.profile.model ?? null }));
      this.summaries.set(cacheKey, summary);
      const failed = summary;
      void summary.catch(() => {
        if (this.summaries.get(cacheKey) === failed) this.summaries.delete(cacheKey);
      });
      while (this.summaries.size > 128) this.summaries.delete(this.summaries.keys().next().value!);
    }
    const input = await summary,
      question = ["running", "queued"].includes(task.state) ? await this.questions.pending(owner, task.spec.id) : null;
    await this.authorize(owner, task.spec.projectId);
    const current = await this.tasks.get(owner, task.spec.id);
    return {
      id: current.spec.id,
      projectId: current.spec.projectId,
      state: current.state,
      generation: current.generation,
      prompt: input.prompt,
      model: input.model,
      artifact: current.artifact,
      failure: current.failure,
      cancelRequested: current.cancelRequested,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      ...(current.spec.previousTaskId ? { previousTaskId: current.spec.previousTaskId } : {}),
      question:
        question &&
        question.generation === current.generation &&
        !current.cancelRequested &&
        ["running", "queued"].includes(current.state)
          ? { id: question.id, questions: question.questions }
          : null,
    };
  }
  submit(owner: string, value: unknown) {
    return this.using(async () => {
      const task = await this.submissions.submit(owner, value);
      this.runtime.wake();
      return this.view(owner, task);
    });
  }
  list(owner: string, projectId: string) {
    return this.using(async () => {
      const all = projectId === "*";
      if (!all) {
        creationId(projectId);
        await this.authorize(owner, projectId);
      }
      const tasks = (await this.history.list(owner, all ? undefined : projectId)).slice(0, 50);
      const views = await Promise.all(
        tasks.map(async (task) => {
          try {
            return await this.view(owner, task);
          } catch (error) {
            if (all && error instanceof CreationError && error.code === "notFound") return null;
            throw error;
          }
        }),
      );
      return views.filter((task): task is CreationTaskView => task !== null);
    });
  }
  detail(owner: string, id: string, conversation = true) {
    return this.using(async (): Promise<CreationTaskDetail> => {
      const task = await this.view(owner, await this.tasks.get(owner, creationUuid(id))),
        [progress, clarifications] = await Promise.all([
          this.progress?.list(owner, id, conversation) ?? [],
          conversation ? this.questions.historyDetails(owner, id) : [],
        ]);
      await this.authorize(owner, task.projectId);
      return { ...task, progress, clarifications };
    });
  }
  followUp(owner: string, id: string, value: unknown) {
    return this.using(async () => {
      const task = await this.submissions.followUp(owner, creationUuid(id), value);
      this.runtime.wake();
      return this.view(owner, task);
    });
  }
  cancel(owner: string, id: string) {
    return this.using(async () => {
      const task = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, task.spec.projectId);
      const cancelled = await this.tasks.cancel(owner, id, this.now());
      this.runtime.interrupt(owner, id);
      return this.view(owner, cancelled);
    });
  }
  retry(owner: string, id: string, operationId: string) {
    return this.using(async () => {
      const task = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, task.spec.projectId);
      const retried = await this.history.retry(owner, id, operationId, this.now());
      this.runtime.wake();
      return this.view(owner, retried);
    });
  }
  answer(owner: string, id: string, value: unknown) {
    return this.using(async () => {
      const result = await this.questions.answer(owner, creationUuid(id), value);
      this.runtime.wake();
      return this.view(owner, await this.tasks.get(owner, result.taskId));
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
