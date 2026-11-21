import { HarnessError, type HarnessPermissionMode } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { EngineDriver, EngineEvent } from "../../../shared/engine/contracts.js";
import type {
  HarnessAgent,
  HarnessAgentEvent,
  HarnessAgentInfo,
  HarnessNativeSession,
  HarnessPrompt,
} from "../ports.js";
import { rememberApplicationSession } from "../../engines/application-tools/sessions.js";
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");
/** Adapts the existing Codex driver without creating or stopping the application's shared daemon. */
export class CodexHarnessAgent implements HarnessAgent {
  private session: HarnessNativeSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private emitter: ((event: HarnessAgentEvent) => Promise<void>) | null = null;
  private completion: {
    resolve(value: { stopReason: "complete" | "cancelled" }): void;
    reject(error: unknown): void;
  } | null = null;
  private notifications: Promise<void> = Promise.resolve();
  private turnId: string | null = null;
  private cancelled = false;
  private terminal: "complete" | "cancelled" | null = null;
  private readonly permissions = new Set<string>();
  private permissionMode: HarnessPermissionMode = "ask";
  constructor(private readonly driver: EngineDriver) {
    this.unsubscribe = driver.subscribe((event) => this.event(event));
  }
  async initialize(): Promise<HarnessAgentInfo> {
    const result = record(await this.driver.execute("model.list", {}));
    return {
      capabilities: {
        text: true,
        imageInput: true,
        fileInput: true,
        tools: true,
        permissions: true,
        permissionModes: ["ask", "full-access"],
        load: true,
        models: true,
        imageGeneration: "unknown",
      },
      currentModel: null,
      commands: [],
      models: (Array.isArray(result.data) ? result.data : [])
        .map((value) => record(value))
        .filter((value) => typeof value.id === "string" && value.hidden !== true)
        .map((value) => ({
          id: text(value.model) || text(value.id),
          name: text(value.displayName) || text(value.id),
          isDefault: value.isDefault === true,
          defaultEffort: text(value.defaultReasoningEffort) || null,
          efforts: (Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : [])
            .map((effort) => record(effort))
            .map((effort) => ({ id: text(effort.reasoningEffort), name: text(effort.reasoningEffort) })),
        })),
    };
  }
  private async open(cwd: string, id?: string, permissionMode: HarnessPermissionMode = "ask") {
    if (permissionMode !== "ask" && permissionMode !== "full-access") throw new HarnessError("capabilityUnavailable");
    this.permissionMode = permissionMode;
    const result = id
      ? await this.driver.sessions.resume(id)
      : record(
          record(
            await this.driver.execute("session.create", {
              cwd,
              ephemeral: true,
              approvalPolicy: permissionMode === "full-access" ? "never" : "on-request",
              sandbox: permissionMode === "full-access" ? "danger-full-access" : "workspace-write",
            }),
          ).thread,
        );
    if (typeof result.id !== "string" || !result.id) throw new HarnessError("invalidProtocol", 503);
    if (result.cwd && result.cwd !== cwd) throw new HarnessError("workspaceUnavailable", 409);
    this.session = { id: result.id, cwd };
    rememberApplicationSession(result.id);
    return this.session;
  }
  create(cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    return this.open(cwd, undefined, options?.permissionMode);
  }
  load(id: string, cwd: string, options?: { permissionMode?: HarnessPermissionMode }) {
    rememberApplicationSession(id);
    return this.open(cwd, id, options?.permissionMode);
  }
  private event(event: EngineEvent) {
    if (event.kind === "disconnected") {
      this.completion?.reject(new HarnessError("deliveryUncertain", 409));
      return;
    }
    if (event.kind !== "notification" && event.kind !== "approval") return;
    const envelope = event.envelope,
      params = envelope.params ?? {};
    if (!this.emitter || !this.session || params.threadId !== this.session.id) return;
    const emit = this.emitter;
    if (event.kind === "approval") {
      const id = String(event.envelope.id),
        model = event.envelope.surface?.kind === "approval" ? event.envelope.surface.model : null;
      if (!model) {
        this.driver.respond(event.envelope.id, undefined, { code: -32601, message: "Interaction unavailable" });
        return;
      }
      this.permissions.add(id);
      this.notifications = this.notifications.then(() =>
        emit({
          type: "permission",
          id,
          title: model.title,
          options: (["primary", "deny", "leading", "scoped"] as const)
            .filter((key) => !!model[key])
            .map((key) => ({
              id: key,
              name: model[key]!.label,
              kind: key === "deny" ? "reject_once" : key === "primary" ? "allow_once" : "allow_always",
            })),
        }),
      );
    } else if (envelope.method === "item/agentMessage/delta" && typeof params.delta === "string")
      this.notifications = this.notifications.then(() => emit({ type: "text", text: String(params.delta) }));
    else if (envelope.method === "turn/started") {
      this.turnId = text(record(params.turn).id);
      if (this.cancelled) void this.cancel(this.session).catch(() => {});
    } else if (envelope.method === "turn/completed") {
      const completion = this.completion,
        turn = record(params.turn);
      this.notifications = this.notifications.then(() => {
        if (turn.status === "completed") {
          this.terminal = "complete";
          completion?.resolve({ stopReason: "complete" });
        } else if (turn.status === "interrupted") {
          this.terminal = "cancelled";
          completion?.resolve({ stopReason: "cancelled" });
        } else completion?.reject(new HarnessError("deliveryUncertain", 409));
      });
    }
    this.notifications.catch((error) => this.completion?.reject(error));
  }
  async prompt(session: HarnessNativeSession, input: HarnessPrompt, emit: (event: HarnessAgentEvent) => Promise<void>) {
    if (this.emitter || session.id !== this.session?.id) throw new HarnessError("busy", 409);
    if (this.cancelled) return { stopReason: "cancelled" as const };
    this.emitter = emit;
    const done = new Promise<{ stopReason: "complete" | "cancelled" }>((resolve, reject) => {
      this.completion = { resolve, reject };
    });
    void done.catch(() => {});
    const timer = setTimeout(() => this.completion?.reject(new HarnessError("timeout", 504)), 30 * 60 * 1000);
    try {
      const result = record(
        await this.driver.execute("input.start", {
          threadId: session.id,
          input: [
            { type: "text", text: input.text },
            ...input.attachments.map((attachment) =>
              attachment.kind === "image"
                ? { type: "localImage", path: attachment.path }
                : { type: "text", text: `Attached file: ${attachment.path}` },
            ),
          ],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          approvalPolicy: this.permissionMode === "full-access" ? "never" : "on-request",
          approvalsReviewer: "user",
          sandboxPolicy:
            this.permissionMode === "full-access"
              ? { type: "dangerFullAccess" }
              : {
                  type: "workspaceWrite",
                  writableRoots: [session.cwd],
                  networkAccess: false,
                  excludeTmpdirEnvVar: false,
                  excludeSlashTmp: false,
                },
        }),
      );
      this.turnId ||= text(record(result.turn).id);
      if (this.cancelled && this.turnId) await this.cancel(session);
      return await done;
    } catch (error) {
      await this.notifications;
      if (this.terminal) return { stopReason: this.terminal };
      throw error;
    } finally {
      clearTimeout(timer);
      this.completion = null;
      this.emitter = null;
      this.turnId = null;
    }
  }
  async cancel(session: HarnessNativeSession) {
    this.cancelled = true;
    if (session.id !== this.session?.id) throw new HarnessError("notFound", 404);
    if (this.turnId) await this.driver.execute("input.interrupt", { threadId: session.id, turnId: this.turnId });
  }
  async respondPermission(id: string, optionId: string | null) {
    if (!this.permissions.has(id) || (optionId && !["primary", "deny", "leading", "scoped"].includes(optionId)))
      throw new HarnessError("invalidInput");
    this.driver.respond(id, { choiceId: optionId ?? "cancel" });
    this.permissions.delete(id);
  }
  async close() {
    for (const id of this.permissions) {
      try {
        this.driver.respond(id, { choiceId: "cancel" });
      } catch {}
    }
    this.permissions.clear();
    if (this.emitter && this.session) {
      try {
        await this.cancel(this.session);
      } catch {}
    }
    this.completion?.reject(new HarnessError("deliveryUncertain", 409));
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
