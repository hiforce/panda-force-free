import type { CreationExecution } from "../contracts.js";
import type { CreationInputs } from "../input.js";
import type { CreationOutputs } from "../outputs.js";
import type { CreationQuestions } from "../questions/service.js";
import type {
  CreationClaim,
  CreationEngines,
  CreationRunPermit,
  CreationRunTasks,
  CreationScheduling,
} from "./contracts.js";
import { CreationError } from "../contracts.js";
import { creationRunInput } from "../run-input.js";
import { documentCreationTools } from "../document-tools.js";
import type { CreationProgressStore } from "../ports.js";
import type { CreationProgress } from "../../../shared/creation/contracts.js";

/** One leased execution joins immutable input, scoped tools and an engine; durable state owns the outcome. */
export class CreationWorker {
  constructor(
    private readonly tasks: CreationRunTasks,
    private readonly queue: Pick<CreationScheduling, "release" | "fail">,
    private readonly inputs: CreationInputs,
    private readonly outputs: CreationOutputs,
    private readonly questions: CreationQuestions,
    private readonly engines: CreationEngines,
    private readonly authorize: (owner: string, projectId: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly leaseMs = 30000,
    private readonly diagnostic: (error: unknown) => void = () => {},
    private readonly progress?: CreationProgressStore,
  ) {}
  async run(claim: CreationClaim, shutdown: AbortSignal, permit: CreationRunPermit) {
    const lease = { ...claim.lease },
      controller = new AbortController(),
      signal = controller.signal;
    let execution: CreationExecution | null = null,
      waiting = 0;
    let maintenance: Promise<void> | null = null;
    let messages = Promise.resolve();
    const record = async (stage: CreationProgress["stage"], text?: string) => {
      try {
        await this.progress?.record(lease, {
          at: this.now(),
          generation: lease.generation,
          stage,
          ...(text ? { text } : {}),
        });
      } catch (error) {
        this.diagnostic(error);
      }
    };
    const abort = () => controller.abort(shutdown.reason),
      maintain = async () => {
        try {
          const current = await this.tasks.get(lease.owner, lease.taskId);
          if (current.cancelRequested || current.generation !== lease.generation || current.state === "cancelled")
            throw new CreationError("leaseLost");
          if (current.artifact || current.outputDigest) return;
          await this.tasks.heartbeat(lease, this.now(), this.leaseMs);
        } catch (error) {
          controller.abort(error);
        }
      };
    shutdown.addEventListener("abort", abort, { once: true });
    if (shutdown.aborted) abort();
    const heartbeat = setInterval(
      () => {
        if (!maintenance)
          maintenance = maintain().finally(() => {
            maintenance = null;
          });
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      signal.throwIfAborted();
      await this.authorize(lease.owner, claim.task.spec.projectId);
      const input = await this.inputs.read(claim.task.spec),
        history = await this.questions.history(lease.owner, lease.taskId),
        engine = this.engines.select(input.profile),
        tools = documentCreationTools(lease, this.tasks, this.outputs, this.now);
      signal.throwIfAborted();
      if (engine.id !== input.profile.engineId) throw new CreationError("unavailable");
      const result = await engine.run(
        { ...creationRunInput(input, history), tools: tools.definitions },
        {
          signal,
          started: async (scope) => {
            execution = await tools.started(scope);
            await record("started");
          },
          message: (text) => {
            messages = messages.then(() => record("message", text));
            return messages;
          },
          call: async (call) => {
            await this.authorize(lease.owner, claim.task.spec.projectId);
            signal.throwIfAborted();
            await record("saving");
            return tools.call(call);
          },
          question: async (scope, values) => {
            const bound = execution;
            if (!bound || scope.sessionId !== bound.sessionId || scope.runId !== bound.runId)
              throw new CreationError("leaseLost");
            if (!waiting++) permit.suspend();
            try {
              await record("waiting");
              const answer = await this.questions.ask(bound, values, signal);
              await record("answered");
              return answer;
            } finally {
              if (!--waiting && !signal.aborted) await permit.resume(signal);
            }
          },
        },
      );
      const current = await this.tasks.get(lease.owner, lease.taskId);
      if (!current.artifact && !current.outputDigest)
        await this.queue.fail(lease, result.status === "completed" ? "invalidOutput" : "interrupted", this.now());
    } catch (error) {
      if (!signal.aborted) this.diagnostic(error);
      // Cancellation and new generations are checked inside the metadata operation; neither can be overwritten here.
      if (shutdown.aborted) await this.queue.release(lease, this.now());
      else
        await this.queue.fail(
          lease,
          error instanceof CreationError && error.code === "notFound"
            ? "targetChanged"
            : error instanceof Error && "code" in error && error.code === "APPLICATION_ENGINE_DEADLINE"
              ? "timedOut"
              : "interrupted",
          this.now(),
        );
    } finally {
      clearInterval(heartbeat);
      await maintenance;
      await messages;
      shutdown.removeEventListener("abort", abort);
      controller.abort(new Error("Creation execution closed"));
      permit.close();
    }
  }
}
