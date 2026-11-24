import { resolve } from "node:path";
import { HarnessError, HarnessPromptError, type HarnessPermissionMode } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import { tokenUsage } from "../../../shared/engine/usage.js";
import type { TokenCount } from "../../../shared/engine/types.js";
import type {
  HarnessAgent,
  HarnessAgentEvent,
  HarnessAgentInfo,
  HarnessNativeSession,
  HarnessPrompt,
} from "../ports.js";
import { HarnessStdioTransport, type HarnessStdioOptions } from "./stdio.js";

const record = (value: unknown) => (isRecord(value) ? value : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");
const activeMode = (snapshot: Record<string, unknown>) =>
  text(record(record(snapshot.settings).permission).mode) || text(record(snapshot.session).mode);
type Result = { stopReason: "complete" | "cancelled"; usage?: TokenCount };
type Turn = {
  inputId: string;
  started: boolean;
  nativeId?: string;
  emitted: boolean;
  emit(event: HarnessAgentEvent): Promise<void>;
  resolve(value: Result): void;
  reject(error: unknown): void;
};

/** The pinned Linux CLI exposes these compatibility methods alongside the desktop V4 projection. */
export class ZCodeHarnessAgent implements HarnessAgent {
  private readonly transport: HarnessStdioTransport;
  private readonly info: HarnessAgentInfo;
  private discovery?: Promise<HarnessAgentInfo>;
  private session?: HarnessNativeSession;
  private turn?: Turn;
  private cancelled = false;
  private closing?: Promise<void>;
  private readonly approvals = new Map<string, { choices: Map<string, string>; finish(decision: string): void }>();

  constructor(
    private readonly options: (
      Pick<HarnessStdioOptions, "command" | "cwd" | "env"> | { socketPath: string; cwd: string }
    ) & {
      providerId: string;
      model: string;
      efforts?: string[];
      defaultEffort?: string;
      cleanup?(): Promise<void>;
    },
  ) {
    this.info = {
      capabilities: {
        text: true,
        imageInput: false,
        fileInput: false,
        tools: true,
        permissions: true,
        permissionModes: ["ask", "full-access"],
        load: true,
        models: true,
        imageGeneration: "unknown",
      },
      models: [
        {
          id: options.model,
          name: options.model,
          isDefault: true,
          defaultEffort: options.defaultEffort,
          efforts: (options.efforts ?? []).map((id) => ({ id, name: id })),
        },
      ],
      currentModel: options.model,
      commands: [],
    };
    this.transport = new HarnessStdioTransport({
      ...("socketPath" in options ? options : { ...options, args: ["app-server", "--stdio"] }),
      protocol: "zcode",
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.request(method, params),
      onDisconnect: (error) => this.turn?.reject(error),
    });
  }

  private selection(effort = this.options.defaultEffort) {
    return {
      providerId: this.options.providerId,
      modelId: this.options.model,
      ...(effort ? { options: { reasoningLevel: effort } } : {}),
    };
  }

  initialize() {
    return (this.discovery ??= this.transport.request("runtime/capabilities").then((value) => {
      if (record(value).sessionWorkspaceRouting !== true) throw new HarnessError("invalidProtocol", 503);
      return this.info;
    }));
  }

  private async open(cwd: string, id?: string, permissionMode: HarnessPermissionMode = "ask") {
    if (permissionMode !== "ask" && permissionMode !== "full-access")
      throw new HarnessError("capabilityUnavailable", 409);
    if (resolve(cwd) !== resolve(this.options.cwd)) throw new HarnessError("workspaceUnavailable", 409);
    await this.initialize();
    const workspace = { workspacePath: cwd, workspaceKey: cwd };
    const model = this.selection();
    const result = record(
      await (id
        ? this.transport.request("session/resume", { sessionId: id, workspace })
        : this.transport.request("session/create", {
            workspace,
            model,
            mode: "build",
            persistence: "immediate",
            titleGenerationEnabled: false,
          })),
    );
    const native = record(result.session),
      sessionId = text(native.sessionId);
    const nativeCwd = text(record(native.workspace).workspacePath);
    if (!sessionId || (id && sessionId !== id)) throw new HarnessError("invalidProtocol", 503);
    if (!nativeCwd || resolve(nativeCwd) !== resolve(cwd)) throw new HarnessError("workspaceUnavailable", 409);
    // ZCode can restore a session in build mode even if the previous process confirmed full access.
    const mode = permissionMode === "full-access" ? "yolo" : "build";
    if (activeMode(result) !== mode) {
      const result = record(await this.transport.request("session/setMode", { sessionId, mode }));
      const applied = record(result.session);
      if (applied.sessionId !== sessionId || activeMode(result) !== mode)
        throw new HarnessError("capabilityUnavailable", 409);
    }
    await this.transport.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
    this.session = { id: sessionId, cwd, info: this.info };
    return this.session;
  }

  create(cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open(cwd, undefined, options?.permissionMode);
  }

  load(id: string, cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open(cwd, id, options?.permissionMode);
  }

  private async notification(method: string, params: Record<string, unknown>) {
    const turn = this.turn;
    if (method !== "session/event" || !turn || params.sessionId !== this.session?.id) return;
    const payload = record(params.payload);
    if (typeof payload.inputId === "string" && payload.inputId !== turn.inputId) return;
    if (params.type === "turn.started") {
      if (turn.started || payload.inputId !== turn.inputId) return;
      turn.started = true;
      turn.nativeId = text(params.turnId);
      await turn.emit({ type: "activity" });
      return;
    }
    if (!turn.started || (turn.nativeId && params.turnId !== turn.nativeId)) return;
    if (params.type === "model.streaming") {
      if (payload.kind === "reasoning_delta" && text(payload.delta)) await turn.emit({ type: "activity" });
      else if (payload.kind === "text_delta" && typeof payload.delta === "string") {
        turn.emitted = true;
        await turn.emit({ type: "text", text: payload.delta });
      }
    } else if (params.type === "tool.updated") {
      await this.toolUpdate(turn, payload);
    } else if (params.type === "turn.completed") {
      if (payload.resultType !== "success" && payload.resultType !== "cancelled") {
        turn.reject(new HarnessError("deliveryUncertain", 409));
        return;
      }
      if (!turn.emitted && typeof payload.response === "string" && payload.response)
        await turn.emit({ type: "text", text: payload.response });
      const reported = record(payload.usage);
      const usage =
        reported.source === "provider"
          ? tokenUsage({
              total: {
                ...reported,
                cachedInputTokens: reported.cacheReadTokens,
                cacheWriteInputTokens: reported.cacheWriteTokens,
                reasoningOutputTokens: reported.reasoningTokens,
              },
            })?.total
          : undefined;
      turn.resolve({ stopReason: payload.resultType === "cancelled" ? "cancelled" : "complete", usage });
    } else if (params.type === "turn.failed") turn.reject(new HarnessError("deliveryUncertain", 409));
  }

  private async toolUpdate(turn: Turn, payload: Record<string, unknown>) {
    if (payload.kind === "batch" && Array.isArray(payload.toolCallIds)) {
      const ids = payload.toolCallIds;
      const status =
        payload.successCount === ids.length ? "complete" : payload.errorCount === ids.length ? "error" : null;
      if (status) for (const id of ids) if (text(id)) await turn.emit({ type: "tool", id, name: "tool", status });
      return;
    }
    const id = text(payload.toolCallId);
    if (!id) return;
    const name = text(payload.toolName).slice(0, 120) || "tool";
    if (payload.kind === "scheduled" || payload.kind === "started")
      await turn.emit({ type: "tool", id, name, status: "running" });
    else if (payload.kind === "result" || payload.kind === "error")
      await turn.emit({ type: "tool", id, name, status: payload.kind === "result" ? "complete" : "error" });
  }

  private async request(method: string, params: Record<string, unknown>) {
    if (method === "session/requestRuntimePreferences") return { nativeSearchEnhancementsEnabled: false };
    if (method !== "interaction/requestPermission") throw new HarnessError("capabilityUnavailable");
    if (!this.turn || this.cancelled || params.sessionId !== this.session?.id || this.approvals.size >= 16)
      return { decision: "deny" };
    const id = text(params.requestId),
      choices = new Map<string, string>();
    if (!id || this.approvals.has(id)) return { decision: "deny" };
    const options = (Array.isArray(params.options) ? params.options : []).flatMap((value) => {
      const option = record(value),
        optionId = text(option.optionId),
        decision = record(option.response).decision;
      if (decision !== "deny" && (decision !== "allow" || option.kind !== "allow_once")) return [];
      if (!optionId) return [];
      choices.set(optionId, decision);
      return [{ id: optionId, name: text(option.name), kind: decision === "allow" ? "allow_once" : "reject_once" }];
    });
    if (!options.length) return { decision: "deny" };
    const response = new Promise<string>((finish) => this.approvals.set(id, { choices, finish }));
    try {
      await this.turn.emit({ type: "permission", id, title: text(params.reason) || text(params.toolName), options });
      return { decision: await response };
    } finally {
      this.approvals.delete(id);
    }
  }

  async prompt(session: HarnessNativeSession, input: HarnessPrompt, emit: Turn["emit"]) {
    if (this.turn || session.id !== this.session?.id) throw new HarnessPromptError("busy", false, 409);
    if (
      input.attachments.length ||
      (input.effort && !this.options.efforts?.includes(input.effort)) ||
      (input.model && input.model !== this.options.model)
    )
      throw new HarnessPromptError("capabilityUnavailable", false, 409);
    if (this.cancelled) return { stopReason: "cancelled" as const };
    const done = new Promise<Result>((resolve, reject) => {
      this.turn = { inputId: input.operationId, started: false, emitted: false, emit, resolve, reject };
    });
    void done.catch(() => {});
    const timer = setTimeout(() => this.turn?.reject(new HarnessError("timeout", 504)), 30 * 60 * 1000);
    try {
      const result = record(
        await this.transport.request("session/send", {
          sessionId: session.id,
          content: input.text,
          inputId: input.operationId,
          modelSelection: this.selection(input.effort ?? undefined),
        }),
      );
      if (result.accepted !== true || result.sessionId !== session.id) throw new HarnessError("invalidProtocol", 503);
      return await done;
    } finally {
      clearTimeout(timer);
      this.turn = undefined;
      for (const pending of this.approvals.values()) pending.finish("deny");
    }
  }

  async cancel(session: HarnessNativeSession) {
    if (session.id !== this.session?.id) throw new HarnessError("notFound", 404);
    this.cancelled = true;
    for (const pending of this.approvals.values()) pending.finish("deny");
    if (this.turn) await this.transport.request("session/stop", { sessionId: session.id });
  }

  async respondPermission(id: string, optionId: string | null) {
    const pending = this.approvals.get(id);
    if (!pending) throw new HarnessError("notFound", 404);
    const decision = optionId === null ? "deny" : pending.choices.get(optionId);
    if (!decision) throw new HarnessError("invalidInput");
    this.approvals.delete(id);
    pending.finish(decision);
  }

  close() {
    return (this.closing ??= (async () => {
      for (const pending of this.approvals.values()) pending.finish("deny");
      this.turn?.reject(new HarnessError("deliveryUncertain", 409));
      try {
        await this.transport.close();
      } finally {
        await this.options.cleanup?.();
      }
    })());
  }
}
