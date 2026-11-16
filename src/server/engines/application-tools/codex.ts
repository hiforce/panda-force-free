import { isRecord } from "../../../shared/records.js";
import type { ApplicationRunScope, ApplicationToolEngine } from "../../../shared/engine/application-tools.js";
import type { CodexConnection, CodexTransport, CodexTransportFactory } from "../codex-transport.js";
import { createCodexBridge } from "../../bridge/codex-process.js";
import { codexApplicationThread } from "./codex-policy.js";
import { codexApplicationCalls } from "./codex-calls.js";
import { ActiveRunBudget } from "../active-budget.js";
import { rememberApplicationSession } from "./sessions.js";

function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("Invalid application engine identity");
  return value;
}
/** Each run owns a connection; persistent threads are explicit opt-ins; shared transports are detached, never terminated globally. */
export function createCodexApplicationEngine(
  options: {
    connection: CodexConnection;
    scratchDirectory: string;
    version: string;
    model?: string;
    timeoutMs?: number;
    purpose?: "creation" | "knowledge" | "bots";
  },
  factory: CodexTransportFactory = createCodexBridge,
): ApplicationToolEngine {
  return {
    id: "codex",
    async run(value, callbacks) {
      callbacks.signal.throwIfAborted();
      const input = structuredClone(value),
        timeoutMs = options.timeoutMs ?? (options.purpose === "creation" ? 600000 : 120000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
        throw new Error("Invalid application engine deadline");
      if (
        !input.prompt.trim() ||
        Buffer.byteLength(input.prompt) > 262144 ||
        Buffer.byteLength(input.instructions) > 262144 ||
        !input.tools.length ||
        input.tools.length > 16 ||
        new Set(input.tools.map((tool) => tool.name)).size !== input.tools.length ||
        input.tools.some((tool) => !/^[a-z][a-z0-9_]{1,63}$/.test(tool.name) || !isRecord(tool.inputSchema))
      )
        throw new Error("Invalid application engine input");
      let stopping = false,
        closing = false,
        scope: ApplicationRunScope | null = null,
        transport!: CodexTransport,
        budget!: ActiveRunBudget,
        terminalObserved = false,
        bound = false;
      const earlyCompletions = new Map<string, "completed" | "failed" | "interrupted">();
      let markReady!: () => void,
        finish!: (result: ApplicationRunScope & { status: "completed" | "failed" | "interrupted" }) => void,
        fail!: (error: Error) => void;
      const ready = new Promise<void>((resolve) => {
          markReady = resolve;
        }),
        completion = new Promise<ApplicationRunScope & { status: "completed" | "failed" | "interrupted" }>(
          (resolve, reject) => {
            finish = resolve;
            fail = reject;
          },
        );
      // A start failure can settle before the main flow awaits completion.
      void completion.catch(() => {});
      const abort = () => {
          stopping = true;
          markReady();
          fail(new Error("Application engine interrupted"));
        },
        calls = codexApplicationCalls({
          tools: input.tools,
          callbacks: {
            ...callbacks,
            ...(callbacks.question
              ? {
                  async question(scope, questions) {
                    const resume = budget.hold();
                    try {
                      return await callbacks.question!(scope, questions);
                    } finally {
                      resume();
                    }
                  },
                }
              : {}),
          },
          scope: () => scope,
          ready,
          stopped: () => stopping || callbacks.signal.aborted,
          respond: (response) => {
            if (!stopping && transport.connected) {
              try {
                transport.sendRaw(response);
              } catch {
                stopping = true;
                markReady();
                fail(new Error("Application engine response failed"));
              }
            }
          },
        });
      transport = factory({
        connection: options.connection,
        defaultCwd: options.scratchDirectory,
        clientInfo: {
          name: "panda-" + (options.purpose ?? "creation"),
          title: options.purpose === "knowledge" ? "PandaForce knowledge" : "PandaForce creation",
          version: options.version,
        },
        isShuttingDown: () => closing,
        onConnected() {},
        onDisconnected() {
          if (!stopping) {
            stopping = true;
            markReady();
            fail(new Error("Application engine disconnected"));
          }
        },
        onMessage(message) {
          if (message.id !== undefined && message.method) {
            void calls(message);
            return;
          }
          if (
            scope &&
            bound &&
            !stopping &&
            message.method === "item/completed" &&
            message.params?.threadId === scope.sessionId &&
            message.params?.turnId === scope.runId
          ) {
            const item: unknown = message.params?.item;
            if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
              void Promise.resolve(callbacks.message?.(item.text.slice(0, 8000))).catch(() => {});
          }
          if (scope && message.method === "turn/completed" && message.params?.threadId === scope.sessionId) {
            const turn: unknown = message.params?.turn;
            if (
              isRecord(turn) &&
              typeof turn.id === "string" &&
              ["completed", "failed", "interrupted"].includes(String(turn.status))
            ) {
              const status = turn.status as "completed" | "failed" | "interrupted";
              if (turn.id === scope.runId && bound) finish({ ...scope, status });
              else if (!bound && earlyCompletions.size < 8) earlyCompletions.set(turn.id, status);
            }
          }
        },
      });
      budget = new ActiveRunBudget(timeoutMs, () => {
        stopping = true;
        markReady();
        fail(Object.assign(new Error("Application engine deadline exceeded"), { code: "APPLICATION_ENGINE_DEADLINE" }));
      });
      callbacks.signal.addEventListener("abort", abort, { once: true });
      if (callbacks.signal.aborted) abort();
      try {
        if (stopping) throw new Error("Application engine interrupted");
        const policy = codexApplicationThread(options.scratchDirectory, input.instructions, input.tools, options.model);
        const started = await transport.request(
          input.sessionId ? "thread/resume" : "thread/start",
          input.sessionId
            ? {
                threadId: identity(input.sessionId),
                cwd: policy.cwd,
                model: policy.model,
                sandbox: policy.sandbox,
                approvalPolicy: policy.approvalPolicy,
                baseInstructions: policy.baseInstructions,
                config: policy.config,
              }
            : { ...policy, ephemeral: !input.persistent },
        );
        if (!isRecord(started) || !isRecord(started.thread)) throw new Error("Invalid application engine start");
        scope = { sessionId: identity(started.thread.id), runId: "" };
        rememberApplicationSession(scope.sessionId);
        await callbacks.session?.(scope.sessionId);
        if (stopping) throw new Error("Application engine interrupted");
        const running = await transport.request("turn/start", {
          threadId: scope.sessionId,
          input: [{ type: "text", text: input.prompt }],
        });
        if (!isRecord(running) || !isRecord(running.turn)) throw new Error("Invalid application engine run");
        scope = { ...scope, runId: identity(running.turn.id) };
        if (stopping) throw new Error("Application engine interrupted");
        await Promise.race([
          Promise.resolve(callbacks.started({ ...scope })),
          completion.then(() => {
            throw new Error("Application run ended during binding");
          }),
        ]);
        bound = true;
        markReady();
        const early = earlyCompletions.get(scope.runId);
        if (early) finish({ ...scope, status: early });
        const result = await completion;
        terminalObserved = true;
        return result;
      } finally {
        budget.close();
        stopping = true;
        markReady();
        callbacks.signal.removeEventListener("abort", abort);
        if (!terminalObserved && scope?.runId && transport.connected) {
          // Interrupt only this owned turn. Detach even when the daemon cannot acknowledge promptly.
          await Promise.race([
            transport.request("turn/interrupt", { threadId: scope.sessionId, turnId: scope.runId }).catch(() => {}),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1000);
              timer.unref();
            }),
          ]);
        }
        closing = true;
        transport.cancelRestart();
        transport.rejectPending(new Error("Application run closed"));
        transport.terminate();
      }
    },
  };
}
