import { randomUUID } from "node:crypto";
import type { ApplicationRunCallbacks, ApplicationRunScope } from "../../shared/engine/application-tools.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import type { HarnessAgent, HarnessNativeSession } from "./ports.js";

interface PromptOptions {
  agent: HarnessAgent;
  native: HarnessNativeSession;
  scope: ApplicationRunScope;
  callbacks: ApplicationRunCallbacks;
  signal: AbortSignal;
  prompt: string;
  model: string;
  effort: string | null;
  creation: boolean;
  reportUsage: boolean;
  toolBusy(): boolean;
  onToolIdle(wake?: () => void): void;
  activity(): void;
}

/** Serial continuation for agents whose native transport accepts one prompt at a time. */
export async function harnessApplicationPrompts(options: PromptOptions) {
  const { agent, native, scope, callbacks, signal } = options;
  type Acknowledgement = ReturnType<typeof Promise.withResolvers<void>>;
  let next: { text: string; ack: Acknowledgement } | undefined;
  let inFlight: Acknowledgement | undefined;
  let cancellation: Promise<void> | undefined;
  let active = false,
    closed = false;
  const interrupt = () => {
    if (!next || !active || cancellation || options.toolBusy() || signal.aborted) return;
    cancellation = agent.cancel(native).catch((error) => {
      next?.ack.reject(error);
      next = undefined;
    });
  };
  const writeStatus = { running: "running", complete: "completed", error: "failed" } as const;
  options.onToolIdle(interrupt);
  const close = () => {
    closed = true;
    const error = signal.reason || new HarnessError("deliveryUncertain", 409);
    next?.ack.reject(error);
    inFlight?.reject(error);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    const control = options.creation
      ? await callbacks.control?.({
          async steer(text) {
            if (closed || next || signal.aborted) throw new HarnessError("deliveryUncertain", 409);
            const ack = Promise.withResolvers<void>();
            next = { text, ack };
            interrupt();
            return ack.promise;
          },
        })
      : undefined;
    let continuation = false,
      textInput = options.prompt;
    for (;;) {
      signal.throwIfAborted();
      const id = continuation ? randomUUID() : scope.runId;
      let text = "",
        workStarted = false;
      active = true;
      const response = await agent.prompt(
        native,
        {
          text: textInput,
          attachments: [],
          model: options.model,
          effort: options.effort,
          operationId: id,
          ...(continuation ? { continuation: true } : {}),
        },
        async (event) => {
          signal.throwIfAborted();
          options.activity();
          if (event.type === "permission") {
            await agent.respondPermission(event.id, null);
            throw new HarnessError("capabilityUnavailable");
          }
          inFlight?.resolve();
          if (options.creation && !workStarted) {
            workStarted = true;
            await callbacks.event?.({ kind: "activity", id, operation: "nativeWork", status: "running" });
          }
          if (options.creation && event.type === "tool" && event.name.toLowerCase() === "write") {
            await callbacks.event?.({
              kind: "activity",
              id: id + ":" + event.id.slice(0, 90),
              operation: "nativeWrite",
              status: writeStatus[event.status],
            });
          }
          if (event.type === "text") {
            text = (text + event.text).slice(0, 64000);
            await callbacks.event?.({
              kind: "message",
              id,
              text,
              complete: false,
              ...(options.creation ? { phase: "commentary" } : {}),
            });
          }
        },
      );
      active = false;
      await cancellation;
      cancellation = undefined;
      signal.throwIfAborted();
      if (options.reportUsage && response.usage)
        await callbacks.event?.({ kind: "usage", usage: { last: response.usage } });
      if (response.stopReason === "complete") inFlight?.resolve();
      else inFlight?.reject(new HarnessError("deliveryUncertain", 409));
      inFlight = undefined;
      if (!next && response.stopReason === "complete") await control?.poll();
      const update = next;
      if (!update) closed = true;
      if (workStarted)
        await callbacks.event?.({
          kind: "activity",
          id,
          operation: "nativeWork",
          status: response.stopReason === "complete" || update ? "completed" : "failed",
        });
      if (text.trim()) {
        await callbacks.event?.({
          kind: "message",
          id,
          text,
          complete: true,
          phase: update ? "commentary" : "final_answer",
        });
        if (!update) await callbacks.message?.(text);
      }
      if (!update)
        return {
          ...scope,
          status: response.stopReason === "complete" ? ("completed" as const) : ("interrupted" as const),
        };
      next = undefined;
      inFlight = update.ack;
      continuation = true;
      textInput =
        "Continue the same task in this session and keep previous user requirements. " +
        "Read panda_creation_context now for the latest requirements and use existing work.\n\n" +
        update.text;
    }
  } finally {
    options.onToolIdle();
    signal.removeEventListener("abort", close);
    close();
  }
}
