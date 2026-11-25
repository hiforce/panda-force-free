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
import { creationToolActivity } from "./activity.js";
import { creationDialogue } from "./dialogue.js";
import type { EngineQuestion } from "../../../shared/engine/questions.js";

/** One leased execution joins immutable input, scoped tools and an engine; durable state owns the outcome. */
export class CreationWorker {
  constructor(
    private readonly tasks: CreationRunTasks,
    private readonly queue: Pick<CreationScheduling, "release" | "fail" | "reply">,
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
    private readonly rendering?: import("./rendering.js").CreationRendering,
  ) {}
  async run(claim: CreationClaim, shutdown: AbortSignal, permit: CreationRunPermit) {
    const lease = { ...claim.lease },
      controller = new AbortController(),
      signal = controller.signal;
    let nativeOutput: ((filename: string) => Promise<Buffer>) | undefined;
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
          stage: event.kind,
          ...(event.kind === "message"
            ? { text: event.text, streaming: !event.complete, phase: event.phase }
            : event.kind === "activity"
              ? { operation: event.operation, status: event.status }
              : { usage: event.usage }),
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
      await record("preparing");
      const input = await this.inputs.read(claim.task.spec),
        directory = await this.workspaces?.open(claim.task.spec),
        history = await this.questions.history(lease.owner, lease.taskId),
        initialGoal = await this.goals?.read(lease.owner, lease.taskId),
        engine = this.engines.select(input.profile, lease.owner),
        dialogue = creationDialogue(input.dialogue === true),
        tools = documentCreationTools(
          lease,
          this.tasks,
          this.outputs,
          this.now,
          () => interaction.version(),
          () => interaction.goalVersion(),
          () =>
            dialogue.delivering() &&
            ((input.outputType === undefined && !input.recoveryFrom && !creationPreviousPaged(input)) ||
              interaction.ready()),
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
        ),
        boundExecution = (call: import("../../../shared/engine/application-tools.js").ApplicationToolCall) => {
          if (!execution || execution.sessionId !== call.sessionId || execution.runId !== call.runId)
            throw new CreationError("leaseLost");
          return { ...execution };
        },
        active = async (call: import("../../../shared/engine/application-tools.js").ApplicationToolCall) => {
          signal.throwIfAborted();
          await this.authorize(lease.owner, claim.task.spec.projectId);
          await this.tasks.assertExecution(boundExecution(call), this.now());
          signal.throwIfAborted();
        },
        ask = async (scope: { sessionId: string; runId: string }, values: EngineQuestion[]) => {
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
        media =
          input.outputType === undefined
            ? undefined
            : this.rendering?.open({
                task: claim.task.spec,
                input,
                signal,
                execution: boundExecution,
                readNativeFile: async (filename) => {
                  if (!nativeOutput) throw new CreationError("unavailable");
                  return nativeOutput(filename);
                },
                active,
                assert: async (call) => {
                  await active(call);
                  if (!dialogue.delivering() || !interaction.ready()) throw new CreationError("conflict");
                  const context = await this.userMessages?.context(lease.owner, lease.taskId),
                    goal = await this.goals?.read(lease.owner, lease.taskId);
                  if (
                    context?.filter(({ record }) => record.taskId === lease.taskId).at(-1)?.record.id !==
                      interaction.version() ||
                    goal?.at !== interaction.goalVersion()
                  )
                    throw new CreationError("conflict");
                  return {
                    ...boundExecution(call),
                    ...(interaction.version() ? { contextVersion: interaction.version() } : {}),
                    ...(interaction.goalVersion() === undefined ? {} : { goalVersion: interaction.goalVersion() }),
                  };
                },
              });
      signal.throwIfAborted();
      if (engine.id !== input.profile.engineId) throw new CreationError("unavailable");
      const result = await engine.run(
        {
          ...creationRunInput(input, history, Boolean(this.destinations), Boolean(this.directories)),
          tools: [
            ...dialogue.definitions,
            ...tools.definitions,
            ...interaction.definitions,
            ...(media?.definitions ?? []),
          ],
        },
        {
          signal,
          ...(directory ? { directory } : {}),
          ...(media?.definitions.some(({ name }) => name === "panda_artifacts_import_file")
            ? {
                nativeFiles: (read: (filename: string) => Promise<Buffer>) => {
                  nativeOutput = read;
                },
              }
            : {}),
          started: async (scope) => {
            execution = await tools.started(scope);
            await record("started");
          },
          message: (text) => {
            // Engines exposing snapshots already report completed messages through that channel.
            if (snapshotMessages || dialogue.answer()) return;
            messages = messages.then(() => record("message", text));
            return messages;
          },
          event: (event) => {
            if (event.kind === "message" && dialogue.answer()) return;
            if (event.kind === "message") snapshotMessages = true;
            snapshots.set(event.kind === "usage" ? "usage" : event.kind + ":" + event.id, structuredClone(event));
            if (event.kind === "message" && event.complete) return flushSnapshots();
            if (!snapshotTimer) snapshotTimer = setTimeout(() => void flushSnapshots(), 250);
          },
          control: (control) => {
            let observedGoal = initialGoal?.at ?? 0;
            if (!this.userMessages && !this.goals) return;
            const deliver = async (scheduled: () => void) => {
              if (signal.aborted) return;
              const goal = await this.goals?.read(lease.owner, lease.taskId);
              if (goal && goal.at > observedGoal) {
                observedGoal = goal.at;
                const sent = control.steer(
                  "The creation goal changed. Read panda_creation_context and apply its current goal before continuing or saving. A cleared goal removes that guidance without undoing the document or user requirements.",
                );
                scheduled();
                await sent;
                return;
              }
              if (!this.userMessages) return;
              const message = await this.userMessages.claim(lease);
              if (!message) return;
              try {
                const payload = await this.userMessages!.read(message);
                signal.throwIfAborted();
                const sent = control.steer(
                  "Accepted user update " +
                    message.id +
                    ". Read panda_creation_context for current skills and attachments before saving. User text:\n" +
                    payload.prompt,
                );
                scheduled();
                await sent;
                await this.userMessages!.settle(lease, message.id, "delivered");
              } catch (error) {
                await this.userMessages!.settle(lease, message.id, "uncertain");
                if (!signal.aborted) this.diagnostic(error);
              }
            };
            let scheduling = Promise.resolve();
            const pump = () => {
              if (dispatching) return scheduling;
              const scheduled = Promise.withResolvers<void>();
              scheduling = scheduled.promise;
              dispatching = deliver(scheduled.resolve)
                .catch(this.diagnostic)
                .finally(() => {
                  dispatching = undefined;
                  scheduled.resolve();
                });
              return scheduling;
            };
            dispatchTimer = setInterval(() => void pump(), 400);
            dispatchTimer.unref();
            void pump();
            return { poll: pump };
          },
          call: async (call) => {
            await this.authorize(lease.owner, claim.task.spec.projectId);
            signal.throwIfAborted();
            boundExecution(call);
            if (dialogue.handles(call.name)) {
              await active(call);
              return dialogue.call(call.arguments, (question) =>
                ask(call, [{ id: randomUUID(), question, isOther: true }]),
              );
            }
            return creationToolActivity(
              this.progress,
              lease,
              call.name,
              async () => {
                const mediaTool = media?.definitions.some((tool) => tool.name === call.name) ? media : undefined;
                if (call.name === CREATE_DOCUMENT_TOOL || (mediaTool && call.name !== "panda_creation_original_read")) {
                  const blocked = dialogue.blockedDelivery();
                  if (blocked) return blocked;
                }
                if (mediaTool) {
                  if (["panda_artifacts_save", "panda_artifacts_import_file"].includes(call.name))
                    await record("saving");
                  return mediaTool.call(call);
                }
                if ([DOCUMENT_DESTINATIONS_TOOL, FILE_DIRECTORY_TOOL].includes(call.name)) return tools.call(call);
                if (call.name !== CREATE_DOCUMENT_TOOL) return interaction.call(call);
                await record("saving");
                return tools.call(call);
              },
              this.now,
              this.diagnostic,
            );
          },
          question: ask,
        },
      );
      const current = await this.tasks.get(lease.owner, lease.taskId);
      const reply = dialogue.answer();
      if (reply && result.status === "completed" && !current.artifact && !current.outputDigest) {
        signal.throwIfAborted();
        await this.authorize(lease.owner, claim.task.spec.projectId);
        await flushSnapshots();
        if (await this.queue.reply(lease, reply, this.now())) return;
      }
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
                : error instanceof Error && "code" in error && error.code === "APPLICATION_ENGINE_INACTIVE"
                  ? "inactive"
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
