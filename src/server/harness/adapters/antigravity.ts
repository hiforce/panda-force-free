import { resolve } from "node:path";
import { HarnessError, HarnessPromptError, type HarnessPermissionMode } from "../../../shared/harness/contracts.js";
import { tokenUsage } from "../../../shared/engine/usage.js";
import type { HarnessAgent, HarnessAgentInfo, HarnessNativeSession, HarnessPrompt } from "../ports.js";
import { AcpTurnEvents, acpPrompt, acpRecord as record, acpText as text, type AcpEmit } from "./acp.js";
import { HarnessStdioTransport, type HarnessStdioOptions } from "./stdio.js";

type LaunchOptions = Pick<HarnessStdioOptions, "command" | "cwd" | "env">;

/** Google-specific ACP configuration and session storage live behind the Harness port. */
export class AntigravityHarnessAgent implements HarnessAgent {
  private readonly transport: HarnessStdioTransport;
  private readonly events = new AcpTurnEvents();
  private readonly info: HarnessAgentInfo = {
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
  private initialized?: Promise<HarnessAgentInfo>;
  private session?: HarnessNativeSession;
  private emit: AcpEmit | null = null;
  private cancelled = false;
  private options: Record<string, unknown>[] = [];

  constructor(
    private readonly launch: LaunchOptions,
    private readonly launchPermission: HarnessPermissionMode = "ask",
  ) {
    if (launchPermission !== "ask" && launchPermission !== "always-approve")
      throw new HarnessError("capabilityUnavailable", 409);
    this.transport = new HarnessStdioTransport({
      ...launch,
      args: launchPermission === "always-approve" ? ["acp", "--dangerously-skip-permissions"] : ["acp"],
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.events.request(method, params, this.session?.id, this.emit),
    });
  }

  initialize() {
    return (this.initialized ??= (async () => {
      const result = record(
        await this.transport.request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "PandaForce", version: "1" },
          clientCapabilities: {},
        }),
      );
      if (result.protocolVersion !== 1) throw new HarnessError("invalidProtocol", 503);
      const capabilities = record(result.agentCapabilities);
      const prompts = record(capabilities.promptCapabilities);
      this.info.capabilities.imageInput = prompts.image === true;
      this.info.capabilities.fileInput = prompts.embeddedContext === true;
      this.info.capabilities.load = "resume" in record(capabilities.sessionCapabilities);
      return this.info;
    })());
  }

  private async open(cwd: string, id: string | undefined, permissionMode: HarnessPermissionMode = "ask") {
    if (this.session || resolve(cwd) !== resolve(this.launch.cwd)) throw new HarnessError("workspaceUnavailable", 409);
    if (permissionMode !== this.launchPermission) throw new HarnessError("capabilityUnavailable", 409);
    await this.initialize();
    if (id && !this.info.capabilities.load) throw new HarnessError("capabilityUnavailable", 409);
    const result = record(
      await this.transport.request(id ? "session/resume" : "session/new", {
        cwd,
        mcpServers: [],
        ...(id ? { sessionId: id } : {}),
      }),
    );
    const nativeId = text(result.sessionId) || id;
    if (!nativeId || (id && id !== nativeId)) throw new HarnessError("invalidProtocol", 503);
    this.session = { id: nativeId, cwd, info: this.info };
    this.updateOptions(result.configOptions);
    await this.select("mode", "default");
    return this.session;
  }

  create(cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open(cwd, undefined, options?.permissionMode);
  }

  load(id: string, cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open(cwd, id, options?.permissionMode);
  }

  private option(id: string) {
    return this.options.find((entry) => entry.id === id);
  }

  private choices(option: Record<string, unknown> | undefined) {
    return (Array.isArray(option?.options) ? option.options : [])
      .flatMap((item) => {
        const entry = record(item);
        return Array.isArray(entry.options) ? entry.options.map(record) : [entry];
      })
      .filter((entry) => text(entry.value) && text(entry.name))
      .map((entry) => ({ id: text(entry.value), name: text(entry.name) }));
  }

  private updateOptions(value: unknown) {
    if (!Array.isArray(value)) return;
    this.options = value.map(record);
    const models = this.option("model");
    const thinking = this.option("thought_level");
    const currentModel = text(models?.currentValue) || null;
    this.info.currentModel = currentModel;
    this.info.models = this.choices(models).map((model) => ({
      ...model,
      isDefault: model.id === currentModel,
      efforts: model.id === currentModel ? this.choices(thinking) : [],
      ...(model.id === currentModel ? { defaultEffort: text(thinking?.currentValue) || null } : {}),
    }));
    this.info.capabilities.models = this.info.models.length > 0;
  }

  private async select(configId: string, value: string) {
    const option = this.option(configId);
    if (option?.currentValue === value) return;
    if (!this.choices(option).some((choice) => choice.id === value))
      throw new HarnessError("capabilityUnavailable", 409);
    const result = record(
      await this.transport.request("session/set_config_option", {
        sessionId: this.session!.id,
        configId,
        value,
      }),
    );
    this.updateOptions(result.configOptions);
    if (this.option(configId)?.currentValue !== value) throw new HarnessError("invalidProtocol", 503);
  }

  private async notification(method: string, params: Record<string, unknown>) {
    if (method !== "session/update" || !this.session || params.sessionId !== this.session.id) return;
    const update = record(params.update);
    if (update.sessionUpdate === "config_option_update") this.updateOptions(update.configOptions);
    else if (update.sessionUpdate === "available_commands_update")
      this.info.commands = (Array.isArray(update.availableCommands) ? update.availableCommands : [])
        .map((command) => text(record(command).name))
        .filter(Boolean);
    else if (this.emit) await this.events.update(update, this.emit);
  }

  async prompt(session: HarnessNativeSession, input: HarnessPrompt, emit: AcpEmit) {
    if (this.emit || this.session?.id !== session.id) throw new HarnessPromptError("busy", false, 409);
    this.emit = emit;
    try {
      let prompt: Awaited<ReturnType<typeof acpPrompt>>;
      try {
        if (input.model) await this.select("model", input.model);
        if (input.effort) await this.select("thought_level", input.effort);
        prompt = await acpPrompt(input, this.info.capabilities);
      } catch (error) {
        throw new HarnessPromptError(
          error instanceof HarnessError ? error.code : "unavailable",
          false,
          error instanceof HarnessError ? error.status : 503,
        );
      }
      if (this.cancelled) return { stopReason: "cancelled" as const };
      const result = record(
        await this.transport.request("session/prompt", { sessionId: session.id, prompt }, 30 * 60 * 1000),
      );
      if (result.stopReason === "cancelled") return { stopReason: "cancelled" as const };
      if (result.stopReason !== "end_turn") throw new HarnessError("deliveryUncertain", 409);
      const reported = record(result.usage);
      const usage = tokenUsage({
        total: {
          inputTokens: reported.inputTokens,
          outputTokens: reported.outputTokens,
          totalTokens: reported.totalTokens,
          cachedInputTokens: reported.cachedReadTokens,
          cacheWriteInputTokens: reported.cachedWriteTokens,
          reasoningOutputTokens: reported.thoughtTokens,
        },
      })?.total;
      return { stopReason: "complete" as const, usage };
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
    if (session.id !== this.session?.id) throw new HarnessError("notFound", 404);
    this.cancelled = true;
    this.events.cancelPermissions();
    await this.transport.notify("session/cancel", { sessionId: session.id });
  }

  async respondPermission(id: string, optionId: string | null) {
    this.events.respond(id, optionId);
  }

  async close() {
    this.events.cancelPermissions();
    await this.transport.close();
  }
}
