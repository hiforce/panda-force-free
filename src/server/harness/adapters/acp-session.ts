import { resolve } from "node:path";
import { HarnessError, HarnessPromptError, type HarnessPermissionMode } from "../../../shared/harness/contracts.js";
import { tokenUsage } from "../../../shared/engine/usage.js";
import type {
  HarnessAgent,
  HarnessAgentInfo,
  HarnessNativeSession,
  HarnessOpenOptions,
  HarnessPrompt,
} from "../ports.js";
import { AcpTurnEvents, acpPrompt, acpRecord as record, acpText as text, type AcpEmit } from "./acp.js";
import { HarnessStdioTransport, HarnessTransportError, type HarnessStdioOptions } from "./stdio.js";

export type AcpLaunchOptions =
  Pick<HarnessStdioOptions, "command" | "cwd" | "env"> | { socketPath: string; cwd: string };
interface AcpSessionOptions {
  args: readonly string[];
  effortId: string;
  permissionMode: "ask" | "always-approve";
  permissionModes: HarnessPermissionMode[];
  nativeModes?: Readonly<Partial<Record<HarnessPermissionMode, string>>>;
  checkAuthStatus?: boolean;
}

/** An ACP subprocess owns its native model configuration and session state. */
export class AcpSessionAgent implements HarnessAgent {
  private readonly transport: HarnessStdioTransport;
  private readonly events = new AcpTurnEvents();
  private readonly info: HarnessAgentInfo = {
    capabilities: {
      text: true,
      imageInput: false,
      fileInput: false,
      tools: true,
      permissions: true,
      permissionModes: [],
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
  private readonly discoveredModels = new Map<string, HarnessAgentInfo["models"][number]>();
  private defaultModel: string | null = null;
  private permissionMode: HarnessPermissionMode = "ask";

  constructor(
    private readonly launch: AcpLaunchOptions,
    private readonly settings: AcpSessionOptions,
  ) {
    this.info.capabilities.permissionModes = settings.permissionModes;
    this.transport = new HarnessStdioTransport({
      ...("socketPath" in launch ? launch : { ...launch, args: settings.args }),
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
      if (this.settings.checkAuthStatus) {
        if (!("status" in record(capabilities.auth))) throw new HarnessError("invalidProtocol", 503);
        const { state } = record(await this.transport.request("auth/status"));
        if (state === "unauthenticated") throw new HarnessError("authentication", 503);
        if (state !== "authenticated" && state !== "unknown") throw new HarnessError("invalidProtocol", 503);
      }
      this.info.capabilities.imageInput = prompts.image === true;
      this.info.capabilities.fileInput = prompts.embeddedContext === true;
      this.info.capabilities.load = "resume" in record(capabilities.sessionCapabilities);
      return this.info;
    })());
  }

  private async open(cwd: string, id: string | undefined, options: HarnessOpenOptions = {}) {
    const { permissionMode = "ask", model, discoverModels } = options;
    if (this.session || resolve(cwd) !== resolve(this.launch.cwd)) throw new HarnessError("workspaceUnavailable", 409);
    if (
      this.settings.nativeModes
        ? !this.settings.nativeModes[permissionMode]
        : permissionMode !== this.settings.permissionMode
    )
      throw new HarnessError("capabilityUnavailable", 409);
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
    this.permissionMode = permissionMode;
    if (model) await this.select("model", model);
    await this.selectPermissionMode();
    if (discoverModels) await this.discoverModels();
    return this.session;
  }

  create(cwd: string, options?: HarnessOpenOptions) {
    return this.open(cwd, undefined, options);
  }

  load(id: string, cwd: string, options?: HarnessOpenOptions) {
    return this.open(cwd, id, options);
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
    const thinking = this.option(this.settings.effortId);
    const currentModel = text(models?.currentValue) || null;
    this.defaultModel ??= currentModel;
    this.info.currentModel = currentModel;
    const offered = this.choices(models);
    const current = offered.find((model) => model.id === currentModel);
    if (current) {
      this.discoveredModels.set(current.id, {
        ...current,
        isDefault: current.id === this.defaultModel,
        efforts: this.choices(thinking),
        defaultEffort: text(thinking?.currentValue) || null,
      });
    }
    this.info.models = offered.map(
      (model) =>
        this.discoveredModels.get(model.id) ?? { ...model, isDefault: model.id === this.defaultModel, efforts: [] },
    );
    this.info.capabilities.models = this.info.models.length > 0;
    if (this.settings.nativeModes) {
      const offeredModes = new Set(this.choices(this.option("mode")).map((choice) => choice.id));
      this.info.capabilities.permissionModes = this.settings.permissionModes.filter((mode) =>
        offeredModes.has(this.settings.nativeModes![mode]!),
      );
    }
  }

  private async discoverModels() {
    const current = this.info.currentModel;
    if (!current) return;
    const candidates = this.info.models.filter(({ id }) => id !== current).slice(0, 24);
    for (const { id } of candidates) {
      try {
        await this.select("model", id);
      } catch (error) {
        if (!(error instanceof HarnessError) || !["capabilityUnavailable", "invalidInput"].includes(error.code))
          throw error;
      }
    }
    await this.select("model", current);
  }

  private async selectPermissionMode() {
    if (this.settings.nativeModes && !this.info.capabilities.permissionModes?.includes(this.permissionMode))
      throw new HarnessError("capabilityUnavailable", 409);
    await this.select("mode", this.settings.nativeModes?.[this.permissionMode] ?? "default");
  }

  private async select(configId: string, value: string) {
    const option = this.option(configId);
    if (option?.currentValue === value) return;
    if (!this.choices(option).some((choice) => choice.id === value))
      throw new HarnessError("capabilityUnavailable", 409);
    const result = record(
      await this.transport
        .request("session/set_config_option", {
          sessionId: this.session!.id,
          configId,
          value,
        })
        .catch((error: unknown) => {
          if (error instanceof HarnessTransportError && error.nativeCode === -32602)
            throw new HarnessError("capabilityUnavailable", 409);
          throw error;
        }),
    );
    this.updateOptions(result.configOptions);
    if (this.option(configId)?.currentValue !== value) throw new HarnessError("capabilityUnavailable", 409);
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
        if (input.model && this.info.currentModel !== input.model) {
          await this.select("model", input.model);
          if (this.settings.nativeModes) await this.selectPermissionMode();
        }
        if (input.effort) await this.select(this.settings.effortId, input.effort);
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
