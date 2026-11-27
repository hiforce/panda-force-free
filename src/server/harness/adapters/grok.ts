import { resolve } from "node:path";
import {
  HarnessError,
  HarnessPromptError,
  type HarnessModel,
  type HarnessPermissionMode,
} from "../../../shared/harness/contracts.js";
import { tokenUsage } from "../../../shared/engine/usage.js";
import type {
  HarnessAgent,
  HarnessAgentEvent,
  HarnessAgentInfo,
  HarnessNativeSession,
  HarnessPrompt,
  HarnessApplicationPolicy,
} from "../ports.js";
import { HarnessStdioTransport, type HarnessNativeConnection } from "./stdio.js";
import type { HarnessCredentialLease } from "../auth/contracts.js";
import { AcpTurnEvents, acpPrompt, acpRecord as record, acpText as text } from "./acp.js";
/** ACP terminates here. It never exposes a Codex envelope or treats thought chunks as portable context. */
export class GrokHarnessAgent implements HarnessAgent {
  private readonly transport: HarnessStdioTransport;
  private initialized: Promise<HarnessAgentInfo> | null = null;
  private closing: Promise<void> | null = null;
  private readonly cleanup: (() => Promise<void>) | undefined;
  private readonly credentials?: Pick<HarnessCredentialLease, "prepare" | "rejected">;
  private authRecoveryUsed = false;
  private info: HarnessAgentInfo = {
    capabilities: {
      text: true,
      imageInput: false,
      fileInput: false,
      tools: true,
      permissions: true,
      permissionModes: ["ask", "always-approve"],
      load: false,
      models: false,
      imageGeneration: "unknown",
    },
    models: [],
    currentModel: null,
    commands: [],
  };
  private session: HarnessNativeSession | null = null;
  private cancelled = false;
  private emit: ((event: HarnessAgentEvent) => Promise<void>) | null = null;
  private readonly events = new AcpTurnEvents();
  constructor(
    options: HarnessNativeConnection & {
      cleanup?: () => Promise<void>;
      application?: HarnessApplicationPolicy;
      credentials?: Pick<HarnessCredentialLease, "prepare" | "rejected">;
    },
  ) {
    this.cleanup = options.cleanup;
    this.credentials = options.credentials;
    this.application = options.application;
    this.transport = new HarnessStdioTransport({
      ...options,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.events.request(method, params, this.session?.id, this.emit),
    });
  }
  private readonly application?: HarnessApplicationPolicy;
  initialize(): Promise<HarnessAgentInfo> {
    return (this.initialized ??= (async () => {
      const result = record(
        await this.transport.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "pandaforce", version: "1" },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }),
      );
      if (result.protocolVersion !== 1) throw new HarnessError("invalidProtocol", 503);
      const capabilities = record(result.agentCapabilities),
        prompts = record(capabilities.promptCapabilities);
      this.info.capabilities.imageInput = prompts.image === true;
      this.info.capabilities.fileInput = prompts.embeddedContext === true;
      this.info.capabilities.load = capabilities.loadSession === true;
      this.updateModels(record(record(result._meta).modelState));
      const methods = Array.isArray(result.authMethods) ? result.authMethods : [];
      if (methods.some((method) => record(method).id === "cached_token"))
        await this.authenticatedRequest("authenticate", { methodId: "cached_token", _meta: { headless: true } });
      return this.info;
    })());
  }
  /** Only authentication and session opening are recoverable here. A dispatched prompt is never replayed. */
  private async authenticatedRequest(method: string, params: Record<string, unknown>) {
    try {
      return await this.transport.request(method, params);
    } catch (error) {
      if (
        !(error instanceof HarnessError) ||
        error.code !== "authentication" ||
        !this.credentials ||
        this.authRecoveryUsed
      )
        throw error;
      this.authRecoveryUsed = true;
      await this.credentials.rejected();
      const authenticated = await this.transport.request("authenticate", {
        methodId: "cached_token",
        _meta: { headless: true },
      });
      return method === "authenticate" ? authenticated : this.transport.request(method, params);
    }
  }
  private updateModels(models: Record<string, unknown>) {
    if (!Array.isArray(models.availableModels)) return;
    const values: HarnessModel[] = [];
    for (const candidate of models.availableModels) {
      const model = record(candidate),
        meta = record(model._meta),
        id = text(model.modelId);
      if (!id) continue;
      const efforts = Array.isArray(meta.reasoningEfforts)
        ? meta.reasoningEfforts
            .map((value) => record(value))
            .filter((value) => typeof value.id === "string")
            .map((value) => ({ id: text(value.id), name: text(value.label) || text(value.id) }))
        : [];
      values.push({
        id,
        name: text(model.name) || id,
        isDefault: id === text(models.currentModelId),
        defaultEffort: text(meta.defaultReasoningEffort) || null,
        efforts,
        ...(typeof meta.totalContextTokens === "number" ? { contextTokens: meta.totalContextTokens } : {}),
      });
    }
    this.info.models = values;
    this.info.currentModel = text(models.currentModelId) || null;
    this.info.capabilities.models = values.length > 0;
  }
  private async open(method: string, cwd: string, sessionId?: string, permissionMode: HarnessPermissionMode = "ask") {
    if (permissionMode !== "ask" && permissionMode !== "always-approve")
      throw new HarnessError("capabilityUnavailable");
    await this.initialize();
    const result = record(
      await this.authenticatedRequest(method, {
        cwd,
        mcpServers: this.application && this.application.scope !== "project-memory" ? [this.application.mcpServer] : [],
        _meta: {
          yoloMode: permissionMode === "always-approve",
          autoMode: false,
          ...(this.application
            ? {
                agentProfile: {
                  name: "pandaforce-application",
                  description: "Scoped PandaForce application tools",
                  promptMode: "full",
                  promptBody: this.application.instructions,
                  injectDefaultTools: false,
                  agentsMd: false,
                  discoverSkills: false,
                  inheritSkills: false,
                  toolConfig: {
                    tools:
                      this.application.scope === "project-memory"
                        ? []
                        : [{ id: "GrokBuild:search_tool" }, { id: "GrokBuild:use_tool" }],
                  },
                },
              }
            : {}),
        },
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    const actual = text(record(result._meta).currentWorkingDirectory) || cwd;
    if (resolve(actual) !== resolve(cwd)) throw new HarnessError("workspaceUnavailable", 409);
    const id = text(result.sessionId) || sessionId;
    if (!id || (sessionId && id !== sessionId)) throw new HarnessError("invalidProtocol", 503);
    this.updateModels(record(result.models));
    const effortOption = (Array.isArray(result.configOptions) ? result.configOptions : [])
      .map(record)
      .find((option) => option.id === "reasoning_effort");
    const current = this.info.models.find((model) => model.id === this.info.currentModel);
    if (!sessionId && current && !current.defaultEffort && typeof effortOption?.currentValue === "string")
      current.defaultEffort = effortOption.currentValue;
    this.session = { id, cwd, info: this.info };
    this.cancelled = false;
    return this.session;
  }
  create(cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open("session/new", cwd, undefined, options?.permissionMode);
  }
  load(id: string, cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open("session/load", cwd, id, options?.permissionMode);
  }
  private async notification(method: string, params: Record<string, unknown>) {
    if (method !== "session/update" || params.sessionId !== this.session?.id) return;
    const update = record(params.update),
      kind = update.sessionUpdate;
    if (kind === "available_commands_update") {
      this.info.commands = (Array.isArray(update.availableCommands) ? update.availableCommands : [])
        .map((value) => text(record(value).name))
        .filter(Boolean);
      return;
    }
    if (this.emit) await this.events.update(update, this.emit);
  }
  private async preparePrompt(session: HarnessNativeSession, input: HarnessPrompt) {
    const model = input.model ? this.info.models.find((value) => value.id === input.model) : null;
    if (
      (input.model && !model) ||
      (input.effort &&
        !(model ?? this.info.models.find((value) => value.id === this.info.currentModel))?.efforts.some(
          (value) => value.id === input.effort,
        ))
    )
      throw new HarnessError("invalidInput");
    if (input.model) {
      const result = record(
        await this.transport.request("session/set_config_option", {
          sessionId: session.id,
          configId: "model",
          value: input.model,
        }),
      );
      this.updateModels(record(result.models));
    }
    if (input.effort)
      await this.transport.request("session/set_config_option", {
        sessionId: session.id,
        configId: "reasoning_effort",
        value: input.effort,
      });
    return acpPrompt(input, this.info.capabilities);
  }
  async prompt(session: HarnessNativeSession, input: HarnessPrompt, emit: (event: HarnessAgentEvent) => Promise<void>) {
    if (this.emit || this.session?.id !== session.id) throw new HarnessPromptError("busy", false, 409);
    if (input.continuation) this.cancelled = false;
    let prompt: Array<Record<string, unknown>>;
    try {
      await this.credentials?.prepare();
      prompt = await this.preparePrompt(session, input);
      if (input.beforeDispatch) await input.beforeDispatch();
    } catch (error) {
      throw new HarnessPromptError(
        error instanceof HarnessError ? error.code : "unavailable",
        false,
        error instanceof HarnessError ? error.status : 503,
      );
    }
    if (this.cancelled) return { stopReason: "cancelled" as const };
    this.emit = emit;
    try {
      const result = record(
        await this.transport.request(
          "session/prompt",
          { sessionId: session.id, prompt },
          this.application ? null : 30 * 60 * 1000,
        ),
      );
      const reported = record(record(result._meta).usage);
      // Sibling counters in _meta cover the last model call, not the whole prompt.
      const usage =
        reported.usageIsIncomplete === true
          ? undefined
          : tokenUsage({
              total: {
                inputTokens: reported.inputTokens,
                outputTokens: reported.outputTokens,
                totalTokens: reported.totalTokens,
                cachedInputTokens: reported.cachedReadTokens,
                cacheWriteInputTokens: reported.cacheCreationTokens,
                reasoningOutputTokens: reported.reasoningTokens,
              },
            })?.total;
      const stopReason = result.stopReason;
      if (stopReason !== "end_turn" && stopReason !== "cancelled") throw new HarnessError("deliveryUncertain", 409);
      return { stopReason: stopReason === "cancelled" ? ("cancelled" as const) : ("complete" as const), usage };
    } catch (error) {
      if (error instanceof Error && "nativeCode" in error && error.nativeCode === -32800)
        return { stopReason: "cancelled" as const };
      throw error;
    } finally {
      this.emit = null;
      this.events.cancelPermissions();
    }
  }
  async cancel(session: HarnessNativeSession) {
    this.cancelled = true;
    if (session.id !== this.session?.id) throw new HarnessError("notFound", 404);
    this.events.cancelPermissions();
    await this.transport.notify("session/cancel", { sessionId: session.id });
  }
  async respondPermission(id: string, optionId: string | null) {
    this.events.respond(id, optionId);
  }
  close() {
    return (this.closing ??= (async () => {
      try {
        this.events.cancelPermissions();
        await this.transport.close();
      } finally {
        await this.cleanup?.();
      }
    })());
  }
}
