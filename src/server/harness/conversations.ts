import { visibleHarnessText } from "../../shared/harness/text.js";
import { harnessSummary } from "../../shared/harness/presentation.js";
import type { HarnessPermission, HarnessHistoryQuery } from "../../shared/harness/contracts.js";
import { handoffContext } from "./context.js";
import { createHash, randomUUID } from "node:crypto";
import {
  HarnessError,
  HarnessPromptError,
  isHarnessPermissionMode,
  type HarnessBinding,
  type HarnessConversation,
  type HarnessHistoryEvent,
  type HarnessMessage,
  type HarnessRun,
  type HarnessConversationSnapshot,
  type HarnessPermissionMode,
} from "../../shared/harness/contracts.js";
import type { TokenCount, TokenUsage } from "../../shared/engine/types.js";
import { addTokenCounts } from "../../shared/engine/usage.js";
import type {
  HarnessAgent,
  HarnessAgentEvent,
  HarnessHistory,
  HarnessMetadata,
  HarnessMetadataTransaction,
  HarnessNativeSession,
  HarnessPrompt,
  HarnessImportedMessage,
  HarnessSourcePage,
} from "./ports.js";
import { HarnessRegistry, type HarnessPrincipal } from "./registry.js";
import { decode, save } from "./records.js";
interface StoredConversation extends HarnessConversation {
  bindings: HarnessBinding[];
  permissions: HarnessPermission[];
  lastRunId?: string;
  tokenUsage?: TokenUsage;
  source?: { threadId: string; cursor: string };
}
function conversationView(value: StoredConversation) {
  const {
    owner: _owner,
    historyBytes: _bytes,
    bindings: _bindings,
    permissions: _permissions,
    lastRunId: _last,
    source: _source,
    tokenUsage: _usage,
    ...view
  } = value;
  return view;
}
interface Execution {
  run: HarnessRun;
  work: Promise<void> | null;
  agent: HarnessAgent | null;
  native: HarnessNativeSession | null;
  pending: string;
  flush: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  cancelled: boolean;
  thinking: boolean;
  permissions: Map<string, string>;
  tools: Map<string, { id: string; status: "running" | "complete" | "error" }>;
}
export interface HarnessConversationOptions {
  metadata: HarnessMetadata;
  history: HarnessHistory;
  registry: HarnessRegistry;
  workspace(principal: HarnessPrincipal, input: { projectId: string | null; cwd?: string }): Promise<string>;
  authorize(principal: HarnessPrincipal, conversation: HarnessConversation): Promise<void>;
  attachments(
    principal: HarnessPrincipal,
    ids: readonly string[],
    conversation: HarnessConversation,
  ): Promise<HarnessPrompt["attachments"]>;
  instructions?(conversation: HarnessConversation): string;
  now?: () => number;
  historyCommand?: readonly string[];
  sourcePage?(principal: HarnessPrincipal, threadId: string, cursor: string): Promise<HarnessSourcePage>;
}
const key = (id: string) => `conversation:${id}`;
const runKey = (id: string) => `run:${id}`;
const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const active = (run: HarnessRun) => ["prepared", "dispatching", "running"].includes(run.status);
export function projectHarnessHistory(events: readonly HarnessHistoryEvent[], partial = false): HarnessMessage[] {
  const messages = new Map<string, HarnessMessage>();
  for (const event of events) {
    if (event.type === "message")
      messages.set(event.message.id, { ...event.message, attachments: [...event.message.attachments] });
    else {
      let message = messages.get(event.messageId);
      if (!message && partial) {
        message = {
          id: event.messageId,
          seq: event.seq,
          role: "assistant",
          runtimeId: event.runtimeId ?? "earlier",
          model: null,
          text: "",
          attachments: [],
          runId: event.runId ?? `earlier:${event.messageId}`,
          status: "complete",
          createdAt: 0,
        };
        messages.set(event.messageId, message);
      }
      if (!message) throw new HarnessError("historyCorrupt", 503);
      if (event.type === "text") message.text += event.text;
      else {
        message.status = event.status;
        message.error = event.error;
      }
    }
  }
  return [...messages.values()];
}
/** The application owns conversation identity, durable visible history, dispatch receipts and native-session bindings. */
export class HarnessConversations {
  private readonly executing = new Map<string, Execution>();
  private readonly epoch = randomUUID();
  private readonly now: () => number;
  private stopped = false;
  constructor(private readonly options: HarnessConversationOptions) {
    this.now = options.now ?? Date.now;
  }
  private async owned(
    principal: HarnessPrincipal,
    id: string,
    tx?: HarnessMetadataTransaction,
    includeDeleted = false,
  ) {
    if (!validId(id)) throw new HarnessError("notFound", 404);
    const conversation = decode<StoredConversation>(await (tx ? tx.get(key(id)) : this.options.metadata.read(key(id))));
    if (!conversation || conversation.owner !== principal.owner || (!includeDeleted && conversation.archivedAt != null))
      throw new HarnessError("notFound", 404);
    await this.options.authorize(principal, conversation);
    return conversation;
  }
  private async permissionMode(
    principal: HarnessPrincipal,
    runtimeId: string,
    value: unknown,
  ): Promise<HarnessPermissionMode> {
    if (!isHarnessPermissionMode(value)) throw new HarnessError("invalidInput");
    const runtime = await this.options.registry.require(principal, runtimeId);
    if (value !== "ask" && !this.options.registry.view(runtime).capabilities?.permissionModes?.includes(value))
      throw new HarnessError("capabilityUnavailable", 409);
    return value;
  }
  private async write(
    tx: HarnessMetadataTransaction,
    conversation: StoredConversation,
    events: HarnessHistoryEvent[] = [],
  ) {
    if (events.length)
      conversation.historyBytes = await this.options.history.append(
        conversation.owner,
        conversation.id,
        conversation.historyBytes,
        events.map((event) => ({
          ...event,
          runtimeId: event.type === "message" ? event.message.runtimeId : conversation.runtimeId,
          runId:
            event.runId ?? (event.type === "message" ? event.message.runId : (conversation.activeRunId ?? undefined)),
        })),
      );
    conversation.revision++;
    conversation.updatedAt = this.now();
    await save(tx, key(conversation.id), "conversation", conversation.owner, conversation);
  }
  async create(
    principal: HarnessPrincipal,
    input: {
      runtimeId?: string;
      permissionMode?: HarnessPermissionMode;
      projectId?: string | null;
      cwd?: string;
      title?: string;
      history?: HarnessImportedMessage[];
      source?: { threadId: string; cursor: string };
    },
  ) {
    const catalog = await this.options.registry.catalog(principal),
      runtimeId = input.runtimeId || catalog.defaultRuntimeId;
    await this.options.registry.require(principal, runtimeId);
    const permissionMode = await this.permissionMode(principal, runtimeId, input.permissionMode ?? "ask");
    const projectId = input.projectId ?? null,
      cwd = await this.options.workspace(principal, { projectId, cwd: input.cwd });
    const now = this.now(),
      id = randomUUID();
    const conversation: StoredConversation = {
      id,
      owner: principal.owner,
      projectId,
      cwd,
      title: (input.title || "").slice(0, 160),
      runtimeId,
      permissionMode,
      revision: 0,
      lastSeq: 0,
      historyBytes: 0,
      activeRunId: null,
      bindings: [],
      permissions: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ...(input.source ? { source: input.source } : {}),
    };
    const imported = input.history ?? [];
    if (
      imported.length > 2000 ||
      Buffer.byteLength(JSON.stringify(imported)) > 512 * 1024 ||
      imported.some((message) => !["user", "assistant", "tool"].includes(message.role))
    )
      throw new HarnessError("contextTooLarge", 413);
    await this.options.metadata.transaction(async (tx) => {
      const events: HarnessHistoryEvent[] = imported.map((message) => {
        const seq = ++conversation.lastSeq;
        return {
          type: "message",
          seq,
          message: {
            ...message,
            id: message.id ?? randomUUID(),
            seq,
            runId: message.runId ?? `import:${seq}`,
            runtimeId: "import",
            model: null,
            attachments: [],
            status: "complete",
            createdAt: message.createdAt ?? 0,
            sourceTimestampKnown: message.createdAt !== undefined,
          },
        };
      });
      await this.write(tx, conversation, events);
    });
    return this.snapshot(principal, id);
  }
  async list(principal: HarnessPrincipal) {
    const values = (await this.options.metadata.list("conversation", principal.owner)).map((row) =>
      decode<StoredConversation>(row)!,
    );
    const result: Array<Omit<HarnessConversation, "owner" | "historyBytes">> = [];
    for (const value of values) {
      try {
        await this.options.authorize(principal, value);
        if (!value.archivedAt) result.push(conversationView(value));
      } catch {}
    }
    return result;
  }
  async summary(principal: HarnessPrincipal, id: string) {
    return harnessSummary(await this.owned(principal, id));
  }
  async snapshot(
    principal: HarnessPrincipal,
    id: string,
    page: { beforeBytes?: number; sourceCursor?: string; beforeSeq?: number } = {},
  ): Promise<HarnessConversationSnapshot & { permissions: HarnessPermission[] }> {
    let conversation = await this.owned(principal, id);
    if (conversation.activeRunId) {
      const run = decode<HarnessRun>(await this.options.metadata.read(runKey(conversation.activeRunId)));
      if (run && active(run) && run.leaseUntil < this.now()) {
        await this.finish(run, "uncertain", "deliveryUncertain", { expired: true });
        conversation = await this.owned(principal, id);
      }
    }
    const window = await this.options.history.window(principal.owner, id, conversation.historyBytes, {
      beforeBytes: page.beforeBytes,
    });
    let messages = projectHarnessHistory(window.events, window.truncated);
    let nextCursor = window.truncated
      ? String(window.startBytes)
      : conversation.source
        ? `source:${Buffer.from(JSON.stringify({ cursor: conversation.source.cursor, beforeSeq: 1 })).toString("base64url")}`
        : null;
    if (page.sourceCursor) {
      if (
        !conversation.source ||
        !this.options.sourcePage ||
        !Number.isSafeInteger(page.beforeSeq) ||
        page.beforeSeq! > 1
      )
        throw new HarnessError("invalidInput");
      const source = await this.options.sourcePage(principal, conversation.source.threadId, page.sourceCursor);
      const start = page.beforeSeq! - source.history.length;
      messages = source.history.map((message, index) => ({
        ...message,
        id: message.id ?? `source:${start + index}`,
        runId: message.runId ?? `source:${start + index}`,
        runtimeId: "import",
        model: null,
        seq: start + index,
        attachments: [],
        status: "complete",
        createdAt: message.createdAt ?? 0,
      }));
      nextCursor = source.cursor
        ? `source:${Buffer.from(JSON.stringify({ cursor: source.cursor, beforeSeq: start })).toString("base64url")}`
        : null;
    }
    const catalog = await this.options.registry.catalog(principal);
    const lastId = conversation.activeRunId || conversation.lastRunId;
    const lastRun = lastId ? decode<HarnessRun>(await this.options.metadata.read(runKey(lastId))) : null;
    const {
      owner: _owner,
      historyBytes: _bytes,
      bindings: _bindings,
      permissions,
      lastRunId: _lastRunId,
      source: _source,
      tokenUsage,
      ...view
    } = conversation;
    return {
      conversation: view,
      messages,
      run: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            runtimeId: lastRun.runtimeId,
            model: lastRun.model,
            effort: lastRun.effort,
            thinking: lastRun.thinking,
            error: lastRun.error,
            createdAt: lastRun.createdAt,
            updatedAt: lastRun.updatedAt,
          }
        : null,
      runtime: catalog.runtimes.find((runtime) => runtime.id === conversation.runtimeId) ?? null,
      ...(tokenUsage ? { tokenUsage } : {}),
      cursor: String(conversation.revision),
      history: { beforeBytes: window.startBytes, hasEarlier: !!nextCursor, nextCursor },
      permissions,
    };
  }
  async switch(principal: HarnessPrincipal, id: string, runtimeId: string, revision: number) {
    await this.options.registry.require(principal, runtimeId);
    await this.options.metadata.transaction(async (tx) => {
      const conversation = await this.owned(principal, id, tx);
      if (conversation.activeRunId) throw new HarnessError("busy", 409);
      if (conversation.revision !== revision) throw new HarnessError("conflict", 409);
      conversation.runtimeId = runtimeId;
      conversation.permissionMode = "ask";
      await this.write(tx, conversation);
    });
    return this.snapshot(principal, id);
  }
  async configurePermission(principal: HarnessPrincipal, id: string, mode: unknown, revision: number) {
    const selected = await this.owned(principal, id);
    const permissionMode = await this.permissionMode(principal, selected.runtimeId, mode);
    await this.options.metadata.transaction(async (tx) => {
      const conversation = await this.owned(principal, id, tx);
      if (conversation.activeRunId) throw new HarnessError("busy", 409);
      if (conversation.revision !== revision || conversation.runtimeId !== selected.runtimeId)
        throw new HarnessError("conflict", 409);
      conversation.permissionMode = permissionMode;
      await this.write(tx, conversation);
    });
    return this.snapshot(principal, id);
  }
  /** A durable tombstone fences every read/send and late callback without touching project or native source files. */
  async delete(principal: HarnessPrincipal, id: string) {
    await this.options.metadata.transaction(async (tx) => {
      const value = await this.owned(principal, id, tx, true);
      if (value.archivedAt != null) return;
      const run = value.activeRunId ? decode<HarnessRun>(await tx.get(runKey(value.activeRunId))) : null;
      if (run && active(run)) throw new HarnessError("busy", 409);
      value.archivedAt = this.now();
      value.activeRunId = null;
      value.permissions = [];
      await this.write(tx, value);
    });
  }
  async rename(principal: HarnessPrincipal, id: string, title: string) {
    if (!title.trim() || title.length > 160) throw new HarnessError("invalidInput");
    await this.options.metadata.transaction(async (tx) => {
      const value = await this.owned(principal, id, tx);
      value.title = title.trim();
      await this.write(tx, value);
    });
  }
  async submit(
    principal: HarnessPrincipal,
    id: string,
    input: {
      requestId: string;
      clientId?: string;
      text: string;
      attachmentIds?: string[];
      model?: string | null;
      effort?: string | null;
    },
  ) {
    if (this.stopped) throw new HarnessError("unavailable", 503);
    if (
      !validId(input.requestId) ||
      typeof input.text !== "string" ||
      Buffer.byteLength(input.text) > 256 * 1024 ||
      (!input.text.trim() && !input.attachmentIds?.length)
    )
      throw new HarnessError("invalidInput");
    if (
      input.clientId !== undefined &&
      (typeof input.clientId !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/.test(input.clientId))
    )
      throw new HarnessError("invalidInput");
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          text: input.text,
          clientId: input.clientId,
          attachmentIds: input.attachmentIds ?? [],
          model: input.model ?? null,
          effort: input.effort ?? null,
        }),
      )
      .digest("hex");
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > 20 || attachmentIds.some((id) => typeof id !== "string" || id.length > 512))
      throw new HarnessError("invalidInput");
    const selected = await this.owned(principal, id);
    const attachments = await this.options.attachments(principal, attachmentIds, selected);
    const selectedRuntime = await this.options.registry.require(principal, selected.runtimeId);
    const run = await this.options.metadata.transaction(async (tx) => {
      const conversation = await this.owned(principal, id, tx),
        receiptId = `receipt:${id}:${input.requestId}`;
      const receipt = decode<{ runId: string; digest: string }>(await tx.get(receiptId));
      if (receipt) {
        if (receipt.digest !== digest) throw new HarnessError("conflict", 409);
        return { value: decode<HarnessRun>(await tx.get(runKey(receipt.runId)))!, replay: true };
      }
      if (conversation.activeRunId) throw new HarnessError("busy", 409);
      if (conversation.runtimeId !== selectedRuntime.id) throw new HarnessError("conflict", 409);
      const runtime = selectedRuntime;
      const value: HarnessRun = {
        id: randomUUID(),
        conversationId: id,
        owner: principal.owner,
        requestId: input.requestId,
        requestDigest: digest,
        runtimeId: runtime.id,
        model: input.model ?? runtime.defaultModel,
        effort: input.effort ?? (!input.model || input.model === runtime.defaultModel ? runtime.defaultEffort : null),
        permissionMode: conversation.permissionMode ?? "ask",
        status: "prepared",
        epoch: this.epoch,
        leaseUntil: this.now() + 60000,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      const metadata = attachments.map(({ path: _path, ...view }) => view);
      const messages: HarnessHistoryEvent[] = (["user", "assistant"] as const).map((role) => {
        const seq = ++conversation.lastSeq;
        return {
          type: "message",
          seq,
          message: {
            id: role === "user" ? value.userMessageId : value.assistantMessageId,
            seq,
            runId: value.id,
            role,
            ...(role === "user" && input.clientId ? { clientId: input.clientId } : {}),
            runtimeId: runtime.id,
            model: value.model,
            text: role === "user" ? input.text : "",
            attachments: role === "user" ? metadata : [],
            status: role === "user" ? "complete" : "running",
            createdAt: this.now(),
          },
        };
      });
      conversation.activeRunId = value.id;
      if (!conversation.title) conversation.title = visibleHarnessText(input.text).split("\n")[0]!.slice(0, 100);
      await this.write(tx, conversation, messages);
      await save(tx, runKey(value.id), "run", principal.owner, value);
      await save(tx, receiptId, "receipt", principal.owner, { runId: value.id, digest });
      return { value, replay: false };
    });
    if (!run.replay) {
      const execution: Execution = {
        run: run.value,
        work: null,
        agent: null,
        native: null,
        pending: "",
        flush: Promise.resolve(),
        timer: null,
        heartbeat: null,
        cancelled: false,
        thinking: false,
        permissions: new Map(),
        tools: new Map(),
      };
      this.executing.set(id, execution);
      execution.work = this.execute(principal, execution, attachments).catch(() => {});
    }
    return { runId: run.value.id, replay: run.replay };
  }
  private async fenced(tx: HarnessMetadataTransaction, run: HarnessRun) {
    const current = decode<HarnessRun>(await tx.get(runKey(run.id))),
      conversation = decode<StoredConversation>(await tx.get(key(run.conversationId)));
    if (
      !current ||
      !conversation ||
      current.epoch !== this.epoch ||
      !active(current) ||
      current.leaseUntil < this.now() ||
      conversation.activeRunId !== run.id
    )
      throw new HarnessError("leaseLost", 409);
    return { current, conversation };
  }
  private async execute(principal: HarnessPrincipal, execution: Execution, attachments: HarnessPrompt["attachments"]) {
    const run = execution.run;
    execution.heartbeat = setInterval(() => {
      void this.options.metadata
        .transaction(async (tx) => {
          const { current } = await this.fenced(tx, run);
          current.leaseUntil = this.now() + 60000;
          await save(tx, runKey(run.id), "run", run.owner, current);
        })
        .catch(() => {
          execution.cancelled = true;
          void execution.agent?.close();
        });
    }, 15000);
    execution.heartbeat.unref();
    try {
      const conversation = await this.owned(principal, run.conversationId);
      const permissionMode = run.permissionMode ?? "ask";
      const { agent } = await this.options.registry.agent(principal, run.runtimeId, conversation.id, conversation.cwd, {
        permissionMode,
      });
      execution.agent = agent;
      if (this.stopped || execution.cancelled) {
        await this.finish(run, "cancelled");
        return;
      }
      const initialInfo = await agent.initialize();
      const binding = conversation.bindings.find((value) => value.runtimeId === run.runtimeId);
      if (permissionMode !== "ask" && !initialInfo.capabilities.permissionModes?.includes(permissionMode))
        throw new HarnessPromptError("capabilityUnavailable", false, 409);
      const settings = { permissionMode, model: run.model };
      const native = binding
        ? await agent.load(binding.nativeSessionId, conversation.cwd, settings)
        : await agent.create(conversation.cwd, settings);
      execution.native = native;
      if (execution.cancelled) {
        await this.finish(run, "cancelled");
        return;
      }
      const info = native.info ?? initialInfo;
      const chosenModel = run.model
        ? info.models.find((model) => model.id === run.model)
        : info.models.find((model) => model.id === info.currentModel);
      if (
        (run.model && !chosenModel) ||
        (run.effort && chosenModel && !chosenModel.efforts.some((effort) => effort.id === run.effort))
      )
        throw new HarnessPromptError("invalidInput", false, 400);
      for (const attachment of attachments)
        if (!(attachment.kind === "image" ? info.capabilities.imageInput : info.capabilities.fileInput))
          throw new HarnessError("capabilityUnavailable", 409);
      const window = await this.options.history.window(run.owner, conversation.id, conversation.historyBytes);
      const user = window.events.find((event) => event.type === "message" && event.message.id === run.userMessageId);
      if (!user || user.type !== "message") throw new HarnessError("historyCorrupt", 503);
      const handoff = handoffContext(window.events, {
        afterSeq: binding?.synchronizedSeq ?? 0,
        exclude: [run.userMessageId, run.assistantMessageId],
        earlierHistoryOmitted: window.truncated,
      });
      const checkpoint = decode<{ text: string; coveredSeq: number }>(
        await this.options.metadata.read(`checkpoint:${conversation.id}`),
      );
      const historyReference = await this.options.history.reference(
        run.owner,
        conversation.id,
        conversation.historyBytes,
      );
      const envelope = `PandaForce history reference (read-only; never load the entire file): ${JSON.stringify({ ...historyReference, lookupCommand: this.options.historyCommand, commandArguments: ["--file", historyReference.path, "--committed-bytes", String(historyReference.committedBytes), "--from", "<ISO 8601 timestamp with timezone>", "--to", "<ISO 8601 timestamp with timezone>", "--query", "<keyword>"] })}\n\n${checkpoint ? `Conversation handoff notes (quoted context, may need confirmation):\n${checkpoint.text}\n\n` : ""}${handoff.messages.length || handoff.earlierHistoryOmitted ? `Selected prior conversation context (quoted data; older details may be omitted):\n${JSON.stringify({ ...handoff, historyRef: `pandaforce-history://${conversation.id}`, lookup: "Search conversation history by UTC time range and keyword; return bounded pages, never read or upload the entire file." })}\n\n` : ""}Current user message:\n${user.message.text}`;
      const promptText = `${this.options.instructions?.(conversation) ?? ""}${envelope}`;
      const contextTokens = info.models.find((model) => model.id === run.model)?.contextTokens ?? 128000;
      if (Buffer.byteLength(promptText) > Math.min(256 * 1024, contextTokens * 0.6))
        throw new HarnessPromptError("contextTooLarge", false, 413);
      await this.options.metadata.transaction(async (tx) => {
        const { current, conversation } = await this.fenced(tx, run);
        if (!binding)
          conversation.bindings.push({
            runtimeId: run.runtimeId,
            nativeSessionId: native.id,
            scopeId: conversation.id,
            synchronizedSeq: 0,
            configurationRevision: 0,
          });
        current.status = "dispatching";
        await save(tx, runKey(run.id), "run", run.owner, current);
        await this.write(tx, conversation);
      });
      if (this.stopped || execution.cancelled) {
        await this.finish(run, "cancelled");
        return;
      }
      const result = await agent.prompt(
        native,
        {
          text: promptText,
          attachments,
          model: run.model,
          effort: run.effort,
          operationId: run.id,
        },
        (event) => this.event(execution, event),
      );
      await this.flush(execution);
      await this.finish(
        run,
        execution.cancelled || result.stopReason === "cancelled" ? "cancelled" : "complete",
        undefined,
        { usage: result.usage },
      );
    } catch (error) {
      try {
        await this.flush(execution);
      } catch {}
      const code = error instanceof HarnessError ? error.code : "unavailable";
      const current = decode<HarnessRun>(await this.options.metadata.read(runKey(run.id)));
      const uncertain =
        error instanceof HarnessPromptError
          ? error.dispatched
          : current?.status === "dispatching" || current?.status === "running";
      await this.finish(
        run,
        uncertain ? "uncertain" : execution.cancelled ? "cancelled" : "error",
        uncertain ? "deliveryUncertain" : code,
      ).catch(() => {});
    } finally {
      if (execution.heartbeat) clearInterval(execution.heartbeat);
      if (execution.timer) clearTimeout(execution.timer);
      await execution.agent?.close().catch(() => {});
      this.executing.delete(run.conversationId);
    }
  }
  private async event(execution: Execution, event: HarnessAgentEvent) {
    if (event.type === "activity") {
      if (execution.thinking && !execution.pending) return;
      await this.flush(execution);
      await this.options.metadata.transaction(async (tx) => {
        const { current, conversation } = await this.fenced(tx, execution.run);
        current.thinking = true;
        current.status = "running";
        await save(tx, runKey(current.id), "run", current.owner, current);
        await this.write(tx, conversation);
      });
      execution.thinking = true;
      return;
    }
    if (event.type === "text") {
      execution.pending += event.text;
      if (Buffer.byteLength(execution.pending) >= 16384) await this.flush(execution);
      else if (!execution.timer)
        execution.timer = setTimeout(() => {
          execution.timer = null;
          void this.flush(execution).catch(() => {
            execution.cancelled = true;
            void execution.agent?.close();
          });
        }, 100);
      return;
    }
    if (event.type === "permission") {
      const publicId = randomUUID();
      execution.permissions.set(publicId, event.id);
      await this.options.metadata.transaction(async (tx) => {
        const { current, conversation } = await this.fenced(tx, execution.run);
        if (current.thinking) {
          current.thinking = false;
          await save(tx, runKey(current.id), "run", current.owner, current);
        }
        conversation.permissions.push({ id: publicId, title: event.title, options: event.options });
        await this.write(tx, conversation);
      });
      execution.thinking = false;
    } else if (event.type === "tool") {
      if (execution.tools.get(event.id)?.status === event.status) return;
      await this.flush(execution);
      await this.options.metadata.transaction(async (tx) => {
        const { current, conversation } = await this.fenced(tx, execution.run);
        if (current.thinking) {
          current.thinking = false;
          await save(tx, runKey(current.id), "run", current.owner, current);
        }
        const seq = ++conversation.lastSeq;
        const previous = execution.tools.get(event.id);
        if (previous) {
          await this.write(tx, conversation, [{ type: "status", seq, messageId: previous.id, status: event.status }]);
          previous.status = event.status;
          return;
        }
        const tool = { id: randomUUID(), status: event.status };
        execution.tools.set(event.id, tool);
        await this.write(tx, conversation, [
          {
            type: "message",
            seq,
            message: {
              id: tool.id,
              seq,
              runId: execution.run.id,
              runtimeId: execution.run.runtimeId,
              model: execution.run.model,
              role: "tool",
              text: event.name + (event.text ? `\n${event.text}` : ""),
              attachments: [],
              status: event.status === "running" ? "running" : event.status,
              createdAt: this.now(),
            },
          },
        ]);
      });
      execution.thinking = false;
    }
  }
  private flush(execution: Execution) {
    const body = execution.pending;
    execution.pending = "";
    if (!body) return execution.flush;
    execution.thinking = false;
    execution.flush = execution.flush.then(() =>
      this.options.metadata.transaction(async (tx) => {
        const { current, conversation } = await this.fenced(tx, execution.run);
        current.status = "running";
        if (current.thinking) current.thinking = false;
        await save(tx, runKey(current.id), "run", current.owner, current);
        await this.write(tx, conversation, [
          { type: "text", seq: ++conversation.lastSeq, messageId: current.assistantMessageId, text: body },
        ]);
      }),
    );
    return execution.flush;
  }
  private async finish(
    run: HarnessRun,
    status: "complete" | "cancelled" | "error" | "uncertain",
    error?: HarnessRun["error"],
    { expired = false, usage }: { expired?: boolean; usage?: TokenCount } = {},
  ) {
    await this.options.metadata.transaction(async (tx) => {
      const current = decode<HarnessRun>(await tx.get(runKey(run.id))),
        conversation = decode<StoredConversation>(await tx.get(key(run.conversationId)));
      if (
        !current ||
        !conversation ||
        !active(current) ||
        conversation.activeRunId !== run.id ||
        (expired ? current.leaseUntil >= this.now() : current.epoch !== this.epoch)
      )
        return;
      current.status = status;
      if (current.thinking) current.thinking = false;
      current.error = error;
      current.updatedAt = this.now();
      if (usage)
        conversation.tokenUsage = {
          total: addTokenCounts(conversation.tokenUsage?.total, usage),
          updatedAt: current.updatedAt,
        };
      conversation.permissions = [];
      conversation.lastRunId = current.id;
      if (status !== "uncertain") conversation.activeRunId = null;
      if (status === "complete") {
        const binding = conversation.bindings.find((value) => value.runtimeId === run.runtimeId);
        if (binding) binding.synchronizedSeq = conversation.lastSeq + 1;
      }
      // Interrupted native history cannot be safely reused: the next explicit send starts from visible app history.
      else if (status !== "uncertain")
        conversation.bindings = conversation.bindings.filter((value) => value.runtimeId !== run.runtimeId);
      await this.write(tx, conversation, [
        {
          type: "status",
          seq: ++conversation.lastSeq,
          messageId: current.assistantMessageId,
          status,
          ...(error ? { error } : {}),
        },
      ]);
      await save(tx, runKey(current.id), "run", current.owner, current);
    });
  }
  async history(principal: HarnessPrincipal, id: string, input: HarnessHistoryQuery) {
    const conversation = await this.owned(principal, id);
    return this.options.history.queryTime(principal.owner, id, conversation.historyBytes, input);
  }
  async checkpoint(principal: HarnessPrincipal, id: string, text: string) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 16000) throw new HarnessError("invalidInput");
    await this.options.metadata.transaction(async (tx) => {
      const conversation = await this.owned(principal, id, tx);
      if (conversation.activeRunId) throw new HarnessError("busy", 409);
      const previous = await tx.get(`checkpoint:${id}`);
      const value = {
        text,
        coveredSeq: conversation.lastSeq,
        source: "user",
        updatedAt: this.now(),
      };
      await save(
        tx,
        `checkpoint-version:${id}:${(previous?.revision ?? 0) + 1}`,
        "checkpoint-version",
        principal.owner,
        value,
      );
      await save(tx, `checkpoint:${id}`, "checkpoint", principal.owner, value);
    });
  }
  async cancel(principal: HarnessPrincipal, id: string) {
    const conversation = await this.owned(principal, id),
      execution = this.executing.get(id);
    if (!conversation.activeRunId) return;
    if (!execution || execution.run.id !== conversation.activeRunId) throw new HarnessError("deliveryUncertain", 409);
    execution.cancelled = true;
    if (execution.agent && execution.native) await execution.agent.cancel(execution.native);
  }
  async resolveUncertain(principal: HarnessPrincipal, id: string) {
    await this.options.metadata.transaction(async (tx) => {
      const conversation = await this.owned(principal, id, tx);
      if (!conversation.activeRunId) return;
      const run = decode<HarnessRun>(await tx.get(runKey(conversation.activeRunId)));
      if (run?.status !== "uncertain") throw new HarnessError("busy", 409);
      if (this.executing.has(id)) throw new HarnessError("busy", 409);
      conversation.bindings = conversation.bindings.filter((binding) => binding.runtimeId !== run.runtimeId);
      conversation.activeRunId = null;
      await this.write(tx, conversation);
    });
  }
  async permission(principal: HarnessPrincipal, id: string, publicId: string, optionId: string | null) {
    const conversation = await this.owned(principal, id),
      execution = this.executing.get(id),
      permission = conversation.permissions.find((value) => value.id === publicId),
      nativeId = execution?.permissions.get(publicId);
    if (!permission || !nativeId || !execution?.agent || execution.run.id !== conversation.activeRunId)
      throw new HarnessError("notFound", 404);
    if (optionId && !permission.options.some((option) => option.id === optionId))
      throw new HarnessError("invalidInput");
    await execution.agent.respondPermission(nativeId, optionId);
    execution.permissions.delete(publicId);
    await this.options.metadata.transaction(async (tx) => {
      const { conversation } = await this.fenced(tx, execution.run);
      conversation.permissions = conversation.permissions.filter((value) => value.id !== publicId);
      await this.write(tx, conversation);
    });
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled(
      [...this.executing.values()].map(async (execution) => {
        execution.cancelled = true;
        await execution.agent?.close();
        await this.finish(execution.run, "uncertain", "deliveryUncertain");
        await execution.work;
      }),
    );
  }
}
