import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HarnessError,
  HarnessPromptError,
  type HarnessModel,
  type HarnessPermissionMode,
} from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type {
  HarnessAgent,
  HarnessAgentEvent,
  HarnessAgentInfo,
  HarnessNativeSession,
  HarnessPrompt,
  HarnessApplicationPolicy,
} from "../ports.js";
import { HarnessStdioTransport, type HarnessStdioOptions } from "./stdio.js";
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");
/** ACP terminates here. It never exposes a Codex envelope or treats thought chunks as portable context. */
export class GrokHarnessAgent implements HarnessAgent {
  private readonly transport: HarnessStdioTransport;
  private initialized: Promise<HarnessAgentInfo> | null = null;
  private closing: Promise<void> | null = null;
  private readonly cleanup: (() => Promise<void>) | undefined;
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
  private readonly permissions = new Map<string, { options: Set<string>; resolve(value: unknown): void }>();
  constructor(
    options: Omit<HarnessStdioOptions, "onNotification" | "onRequest"> & {
      cleanup?: () => Promise<void>;
      application?: HarnessApplicationPolicy;
    },
  ) {
    this.cleanup = options.cleanup;
    this.application = options.application;
    this.transport = new HarnessStdioTransport({
      ...options,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.clientRequest(method, params),
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
        await this.transport.request("authenticate", { methodId: "cached_token" });
      return this.info;
    })());
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
      await this.transport.request(method, {
        cwd,
        mcpServers: this.application ? [this.application.mcpServer] : [],
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
                  toolConfig: { tools: [{ id: "GrokBuild:search_tool" }, { id: "GrokBuild:use_tool" }] },
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
    if (!id) throw new HarnessError("invalidProtocol", 503);
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
    if (!this.emit) return;
    if (kind === "agent_message_chunk" && record(update.content).type === "text")
      await this.emit({ type: "text", text: text(record(update.content).text) });
    else if (kind === "tool_call" || kind === "tool_call_update") {
      const status = update.status === "completed" ? "complete" : update.status === "failed" ? "error" : "running";
      await this.emit({
        type: "tool",
        id: text(update.toolCallId),
        name: text(update.title) || text(update.kind) || "tool",
        status,
      });
    }
    // Agent thought chunks remain engine-private and are deliberately excluded from transcript export.
  }
  private async clientRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== "session/request_permission") throw new HarnessError("capabilityUnavailable");
    if (!this.emit || this.permissions.size >= 16 || params.sessionId !== this.session?.id)
      return { outcome: { outcome: "cancelled" } };
    const id = randomUUID();
    const options = (Array.isArray(params.options) ? params.options : [])
      .map((value) => record(value))
      .filter((value) => typeof value.optionId === "string")
      .map((value) => ({ id: text(value.optionId), name: text(value.name), kind: text(value.kind) }));
    if (!options.length) return { outcome: { outcome: "cancelled" } };
    const response = new Promise<unknown>((resolve) =>
      this.permissions.set(id, { resolve, options: new Set(options.map((option) => option.id)) }),
    );
    try {
      await this.emit({ type: "permission", id, title: text(record(params.toolCall).title) || "tool", options });
    } catch (error) {
      await this.respondPermission(id, null);
      throw error;
    }
    return response;
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
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text: input.text }];
    for (const attachment of input.attachments) {
      if (attachment.kind === "image" && this.info.capabilities.imageInput) {
        if (attachment.bytes > 2 * 1024 * 1024) throw new HarnessError("invalidInput", 413);
        const data = await readFile(attachment.path);
        prompt.push({ type: "image", mimeType: attachment.mimeType, data: data.toString("base64") });
      } else if (this.info.capabilities.fileInput) {
        prompt.push({
          type: "resource_link",
          uri: pathToFileURL(attachment.path).href,
          name: attachment.name,
          mimeType: attachment.mimeType,
        });
      } else throw new HarnessError("capabilityUnavailable", 409);
    }
    return prompt;
  }
  async prompt(session: HarnessNativeSession, input: HarnessPrompt, emit: (event: HarnessAgentEvent) => Promise<void>) {
    if (this.emit || this.session?.id !== session.id) throw new HarnessPromptError("busy", false, 409);
    let prompt: Array<Record<string, unknown>>;
    try {
      prompt = await this.preparePrompt(session, input);
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
        await this.transport.request("session/prompt", { sessionId: session.id, prompt }, 30 * 60 * 1000),
      );
      if (result.stopReason === "cancelled") return { stopReason: "cancelled" as const };
      if (result.stopReason !== "end_turn") throw new HarnessError("deliveryUncertain", 409);
      return { stopReason: "complete" as const };
    } catch (error) {
      if (error instanceof Error && "nativeCode" in error && error.nativeCode === -32800)
        return { stopReason: "cancelled" as const };
      throw error;
    } finally {
      this.emit = null;
      for (const id of this.permissions.keys()) await this.respondPermission(id, null);
    }
  }
  async cancel(session: HarnessNativeSession) {
    this.cancelled = true;
    if (session.id !== this.session?.id) throw new HarnessError("notFound", 404);
    for (const id of this.permissions.keys()) await this.respondPermission(id, null);
    await this.transport.notify("session/cancel", { sessionId: session.id });
  }
  async respondPermission(id: string, optionId: string | null) {
    const pending = this.permissions.get(id);
    if (!pending) throw new HarnessError("notFound", 404);
    if (optionId && !pending.options.has(optionId)) throw new HarnessError("invalidInput");
    this.permissions.delete(id);
    pending.resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
  }
  close() {
    return (this.closing ??= (async () => {
      try {
        for (const id of [...this.permissions.keys()])
          if (this.permissions.has(id)) await this.respondPermission(id, null);
        await this.transport.close();
      } finally {
        await this.cleanup?.();
      }
    })());
  }
}
