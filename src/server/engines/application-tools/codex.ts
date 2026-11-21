import { isRecord } from "../../../shared/records.js";
import type {
  ApplicationRunScope,
  ApplicationToolEngine,
  ApplicationRunFailure,
} from "../../../shared/engine/application-tools.js";
import { applicationRunFailure } from "../../../shared/engine/application-failure.js";
import type { CodexConnection, CodexTransport, CodexTransportFactory } from "../codex-transport.js";
import { createCodexBridge } from "../../bridge/codex-process.js";
import { codexApplicationThread } from "./codex-policy.js";
import { codexApplicationCalls } from "./codex-calls.js";
import { ActiveRunBudget, type RunBudgetClock } from "../active-budget.js";
import { rememberApplicationSession } from "./sessions.js";
import { applicationVisibleEvents } from "../../../shared/engine/application-visible-events.js";
import { forgetCodexApplicationSession } from "./codex-forget.js";
import { applicationDefaultEffort, applicationDefaultModel } from "./default-model.js";

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
    effort?: string;
    timeoutMs?: number;
    budgetClock?: RunBudgetClock;
    purpose?: "creation" | "knowledge" | "bots" | "bot-chat" | "editorial";
  },
  factory: CodexTransportFactory = createCodexBridge,
): ApplicationToolEngine {
  return {
    id: "codex",
    forget: (sessionId) => forgetCodexApplicationSession(options, sessionId, factory),
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
      type Terminal = { status: "completed" | "failed" | "interrupted"; failure?: ApplicationRunFailure };
      const earlyCompletions = new Map<string, Terminal>();
      const earlyVisible: Array<{ method: string; params: Record<string, unknown> }> = [];
      const visible = applicationVisibleEvents((event) => {
        void Promise.resolve(callbacks.event?.(event)).catch(() => {});
      });
      let markReady!: () => void,
        finish!: (result: ApplicationRunScope & Terminal) => void,
        fail!: (error: Error) => void;
      const ready = new Promise<void>((resolve) => {
          markReady = resolve;
        }),
        completion = new Promise<ApplicationRunScope & Terminal>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
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
            async call(call) {
              if (options.purpose !== "creation") return callbacks.call(call);
              budget.refresh();
              const resume = budget.hold();
              try {
                return await callbacks.call(call);
              } finally {
                budget.refresh();
                resume();
              }
            },
            ...(callbacks.question
              ? {
                  async question(scope, questions) {
                    const resume = budget.hold();
                    try {
                      return await callbacks.question!(scope, questions);
                    } finally {
                      if (options.purpose === "creation") budget.refresh();
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
          title:
            options.purpose === "knowledge"
              ? "PandaForce knowledge"
              : options.purpose === "bot-chat"
                ? "PandaForce Bot chat"
                : "PandaForce creation",
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
          if (
            options.purpose === "creation" &&
            !stopping &&
            scope?.runId &&
            message.params?.threadId === scope.sessionId &&
            (message.params.turnId === scope.runId || message.method === "thread/tokenUsage/updated") &&
            (message.method?.startsWith("item/") ||
              message.method === "turn/plan/updated" ||
              message.method === "thread/tokenUsage/updated")
          )
            budget.refresh();
          if (message.id !== undefined && message.method) {
            void calls(message);
            return;
          }
          if (
            !stopping &&
            scope &&
            message.params?.threadId === scope.sessionId &&
            ["item/agentMessage/delta", "item/completed", "thread/tokenUsage/updated"].includes(message.method || "")
          ) {
            if (bound && (message.method === "thread/tokenUsage/updated" || message.params.turnId === scope.runId))
              visible(message.method!, message.params);
            else if (!bound && earlyVisible.length < 128 && JSON.stringify(message.params).length <= 65536)
              earlyVisible.push({ method: message.method!, params: message.params });
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
              const status = turn.status as Terminal["status"];
              const terminal: Terminal = {
                status,
                ...(status === "failed" ? { failure: applicationRunFailure(turn.error) } : {}),
              };
              if (turn.id === scope.runId && bound) finish({ ...scope, ...terminal });
              else if (!bound && earlyCompletions.size < 8) earlyCompletions.set(turn.id, terminal);
            }
          }
        },
      });
      budget = new ActiveRunBudget(
        timeoutMs,
        () => {
          stopping = true;
          markReady();
          fail(
            Object.assign(new Error("Application engine stopped making progress"), {
              code: options.purpose === "creation" ? "APPLICATION_ENGINE_INACTIVE" : "APPLICATION_ENGINE_DEADLINE",
            }),
          );
        },
        options.budgetClock,
      );
      callbacks.signal.addEventListener("abort", abort, { once: true });
      if (callbacks.signal.aborted) abort();
      try {
        if (stopping) throw new Error("Application engine interrupted");
        let model = options.model,
          effort: string | null | undefined = options.effort;
        if (effort === "") {
          const catalog = await transport.request("model/list", { limit: 100 });
          model ||= applicationDefaultModel(catalog);
          effort = applicationDefaultEffort(catalog, model);
        }
        const policy = codexApplicationThread(options.scratchDirectory, input.instructions, input.tools, model);
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
          ...(effort !== undefined ? { effort } : {}),
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
        for (const event of earlyVisible)
          if (event.method === "thread/tokenUsage/updated" || event.params.turnId === scope.runId)
            visible(event.method, event.params);
        earlyVisible.length = 0;
        await callbacks.control?.({
          steer: async (prompt) => {
            if (stopping || !bound || terminalObserved || !scope?.runId || callbacks.signal.aborted)
              throw new Error("Application execution closed");
            if (!prompt.trim() || Buffer.byteLength(prompt) > 262144) throw new Error("Invalid application input");
            await transport.request("turn/steer", {
              threadId: scope.sessionId,
              expectedTurnId: scope.runId,
              input: [{ type: "text", text: prompt }],
            });
          },
        });
        const early = earlyCompletions.get(scope.runId);
        if (early) finish({ ...scope, ...early });
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
