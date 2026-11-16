import { CreationError, CreationWriteError, type CreationExecution } from "./contracts.js";
import type { CreationArtifactWriter, CreationOutputContent, CreationOutputTasks } from "./ports.js";

/** Admission is a durable handoff: cancellation fences callbacks, while recovery finishes an already accepted write. */
export class CreationOutputs {
  private readonly pending = new Map<string, Promise<Awaited<ReturnType<CreationOutputTasks["get"]>>>>();
  constructor(
    private readonly tasks: CreationOutputTasks,
    private readonly content: CreationOutputContent,
    private readonly artifacts: CreationArtifactWriter,
    private readonly now: () => number = Date.now,
  ) {}
  async invoke(scope: CreationExecution, value: unknown) {
    // Capture authority before the first await; neither mutable caller objects nor model arguments select it.
    const execution = { ...scope },
      prior = await this.tasks.assertExecution(execution, this.now());
    if (!prior.outputDigest) {
      const digest = await this.content.stage(value);
      await this.tasks.admit(execution, digest, this.now());
    }
    return this.reconcile(execution.owner, execution.taskId);
  }
  reconcile(owner: string, id: string) {
    const key = JSON.stringify([owner, id]),
      prior = this.pending.get(key);
    if (prior) return prior;
    const result = this.commit(owner, id).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
  }
  private async commit(owner: string, id: string) {
    const task = await this.tasks.get(owner, id);
    if (task.artifact) return task;
    if (!task.outputDigest || task.state !== "committing") throw new CreationError("conflict");
    try {
      const artifact = await this.artifacts.commit(task.spec, task.outputDigest);
      return await this.tasks.complete(owner, id, task.outputDigest, artifact, this.now());
    } catch (error) {
      await this.tasks.outputFailure(
        owner,
        id,
        task.outputDigest,
        error instanceof CreationWriteError ? error.failure : "writeUnavailable",
        this.now(),
      );
      throw error;
    }
  }
}
