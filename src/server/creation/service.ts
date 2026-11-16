import type { CreationResult } from "./ports.js";
import type { CreationAvailability, CreationTaskView } from "../../shared/creation/contracts.js";
import type { CreationInputs } from "./input.js";
import type { CreationTask } from "./contracts.js";
import type { CreationSubmissions } from "./submissions.js";
import type { CreationQuestions } from "./questions/service.js";
import { CreationError } from "./contracts.js";
import { creationId, creationUuid } from "./validation.js";

export interface CreationManagement {
  get(owner: string, id: string): CreationResult<CreationTask>;
  cancel(owner: string, id: string, now: number): CreationResult<CreationTask>;
}
export interface CreationHistory {
  list(owner: string, projectId: string): CreationResult<CreationTask[]>;
  retry(owner: string, id: string, operationId: string, now: number): CreationResult<CreationTask>;
}
/** HTTP and future command adapters use the same authorized task operations; internal leases never become browser state. */
export class CreationService {
  private closed = false;
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
    const input = await this.inputs.read(task.spec),
      question = await this.questions.pending(owner, task.spec.id);
    await this.authorize(owner, task.spec.projectId);
    const current = await this.tasks.get(owner, task.spec.id);
    return {
      id: current.spec.id,
      projectId: current.spec.projectId,
      state: current.state,
      generation: current.generation,
      prompt: input.prompt,
      model: input.profile.model ?? null,
      artifact: current.artifact,
      failure: current.failure,
      cancelRequested: current.cancelRequested,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
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
      creationId(projectId);
      await this.authorize(owner, projectId);
      return Promise.all(
        (await this.history.list(owner, projectId)).slice(0, 20).map((task) => this.view(owner, task)),
      );
    });
  }
  detail(owner: string, id: string) {
    return this.using(async () => this.view(owner, await this.tasks.get(owner, creationUuid(id))));
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
