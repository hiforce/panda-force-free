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
import { CreationError, CreationWriteError } from "../contracts.js";
import { creationRunInput, creationPreviousPaged } from "../run-input.js";
import { documentCreationTools, CREATE_DOCUMENT_TOOL } from "../document-tools.js";
import type { CreationProgressStore } from "../ports.js";
import type { CreationProgress } from "../../../shared/creation/contracts.js";
import type { ApplicationVisibleEvent } from "../../../shared/engine/application-tools.js";
import { randomUUID } from "node:crypto";
import { creationInteractionTools } from "./interaction-tools.js";
import { FILE_DIRECTORY_TOOL, type CreationFileDirectories } from "../file-directories.js";
import { DOCUMENT_DESTINATIONS_TOOL, type CreationDocumentDestinations } from "../document-destinations.js";

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
    private readonly userMessages?: import("../messages/service.js").CreationMessages,
    private readonly materials?: import("../materials.js").CreationMaterialPort,
    private readonly goals?: import("../goals/contracts.js").CreationGoalStore,
    private readonly workspaces?: import("../workspaces.js").CreationWorkspaces,
    private readonly destinations?: CreationDocumentDestinations,
    private readonly directories?: CreationFileDirectories,
  ) {}
  async run(claim: CreationClaim, shutdown: AbortSignal, permit: CreationRunPermit) {
    const lease = { ...claim.lease },
      controller = new AbortController(),
      signal = controller.signal;
    let execution: CreationExecution | null = null,
      waiting = 0;
    let maintenance: Promise<void> | null = null;
    let messages = Promise.resolve();
    let snapshotMessages = false;
    let dispatchTimer: ReturnType<typeof setInterval> | undefined;
    let dispatching: Promise<void> | undefined;
    const identities = new Map<string, { id: string; at: number }>();
    const snapshots = new Map<string, ApplicationVisibleEvent>();
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    const flushSnapshots = () => {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
      for (const [key, event] of snapshots) {
        let identity = identities.get(key);
        if (!identity) {
          identity = { id: randomUUID(), at: this.now() };
          identities.set(key, identity);
        }
        const value: CreationProgress = {
          ...identity,
          generation: lease.generation,
          stage: event.kind === "message" ? "message" : "usage",
          ...(event.kind === "message" ? { text: event.text, streaming: !event.complete } : { usage: event.usage }),
        };
        messages = messages.then(async () => {
          try {
            await this.progress?.record(lease, value);
          } catch (error) {
            this.diagnostic(error);
          }
        });
      }
      snapshots.clear();
      return messages;
    };
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
        directory = await this.workspaces?.open(claim.task.spec),
        history = await this.questions.history(lease.owner, lease.taskId),
        engine = this.engines.select(input.profile),
        tools = documentCreationTools(
          lease,
          this.tasks,
          this.outputs,
          this.now,
          () => interaction.version(),
          () => interaction.goalVersion(),
          () => (!input.recoveryFrom && !creationPreviousPaged(input)) || interaction.ready(),
          this.destinations,
          this.directories,
        ),
        interaction = creationInteractionTools(
          lease,
          input,
          this.tasks,
          () => execution,
          this.userMessages,
          this.materials,
          this.goals,
          claim.task.spec.target.locale,
        );
      signal.throwIfAborted();
      if (engine.id !== input.profile.engineId) throw new CreationError("unavailable");
      const result = await engine.run(
        {
          ...creationRunInput(input, history, Boolean(this.destinations), Boolean(this.directories)),
          tools: [...tools.definitions, ...interaction.definitions],
        },
        {
          signal,
          ...(directory ? { directory } : {}),
          started: async (scope) => {
            execution = await tools.started(scope);
            await record("started");
          },
          message: (text) => {
            // Engines exposing snapshots already report completed messages through that channel.
            if (snapshotMessages) return;
            messages = messages.then(() => record("message", text));
            return messages;
          },
          event: (event) => {
            if (event.kind === "message") snapshotMessages = true;
            snapshots.set(event.kind === "message" ? event.id : "usage", structuredClone(event));
            if (event.kind === "message" && event.complete) return flushSnapshots();
            if (!snapshotTimer) snapshotTimer = setTimeout(() => void flushSnapshots(), 250);
          },
          control: (control) => {
            let observedGoal = 0;
            if (!this.userMessages && !this.goals) return;
            const deliver = async () => {
              if (signal.aborted) return;
              const goal = await this.goals?.read(lease.owner, lease.taskId);
              if (goal && goal.at > observedGoal) {
                observedGoal = goal.at;
                await control.steer(
                  "The creation goal changed. Read panda_creation_context and apply its current goal before continuing or saving. A cleared goal removes that guidance without undoing the document or user requirements.",
                );
              }
              if (!this.userMessages) return;
              const message = await this.userMessages.claim(lease);
              if (!message) return;
              try {
                const payload = await this.userMessages!.read(message);
                signal.throwIfAborted();
                await control.steer(
                  "Accepted user update " +
                    message.id +
                    ". Read panda_creation_context for current skills and attachments before saving. User text:\n" +
                    payload.prompt,
                );
                await this.userMessages!.settle(lease, message.id, "delivered");
              } catch (error) {
                await this.userMessages!.settle(lease, message.id, "uncertain");
                if (!signal.aborted) this.diagnostic(error);
              }
            };
            const pump = () => {
              if (!dispatching)
                dispatching = deliver()
                  .catch(this.diagnostic)
                  .finally(() => {
                    dispatching = undefined;
                  });
            };
            dispatchTimer = setInterval(pump, 400);
            dispatchTimer.unref();
            pump();
          },
          call: async (call) => {
            await this.authorize(lease.owner, claim.task.spec.projectId);
            signal.throwIfAborted();
            if ([DOCUMENT_DESTINATIONS_TOOL, FILE_DIRECTORY_TOOL].includes(call.name)) return tools.call(call);
            if (call.name !== CREATE_DOCUMENT_TOOL) return interaction.call(call);
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
          error instanceof CreationWriteError
            ? error.failure
            : error instanceof CreationError && error.code === "notFound"
              ? "targetChanged"
              : error instanceof Error && "code" in error && error.code === "APPLICATION_ENGINE_DEADLINE"
                ? "timedOut"
                : "interrupted",
          this.now(),
        );
    } finally {
      clearInterval(heartbeat);
      clearInterval(dispatchTimer);
      await maintenance;
      await flushSnapshots();
      await dispatching;
      await messages;
      shutdown.removeEventListener("abort", abort);
      controller.abort(new Error("Creation execution closed"));
      permit.close();
    }
  }
}
