import type { EngineEnvelope } from "../../shared/engine/contracts.js";
import { HarnessError, type HarnessHistoryEvent } from "../../shared/harness/contracts.js";
import { isRecord } from "../../shared/records.js";
import type { HarnessHistory, HarnessMetadata } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import { digest, nativeMemoryKind, nativeMemoryKey, type MemoryConversation } from "./records.js";
import { visibleNativeMemoryText } from "./rules.js";
import type { ProjectMemory } from "./service.js";

type Item = { id: string; role: "user" | "assistant"; text: string };
type NativeSource = MemoryConversation & {
  nativeId: string;
  enabledAt: number;
  pending?: { turnId: string; startedAt: number; items: Item[] };
};
type Destination = { owner: string; projectId: string; id: string; cwd: string };

function identity(...parts: string[]) {
  const hash = digest(parts).slice(0, 32);
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20)].join("-");
}
const sourceId = (id: string) => identity("native-memory", id);
const nativeIdPattern = /^[a-zA-Z0-9-]{1,128}$/u;
const itemIdPattern = /^[a-zA-Z0-9_.:-]{1,180}$/u;
function item(value: unknown): Item | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !itemIdPattern.test(value.id)) return;
  const role = value.type === "userMessage" ? "user" : value.type === "agentMessage" ? "assistant" : undefined;
  if (!role) return;
  const text =
    role === "assistant" && typeof value.text === "string"
      ? value.text
      : role === "user" && Array.isArray(value.content)
        ? value.content
            .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
        : "";
  // Match the organizer's bounded text input. Do not stage tool output or attachment bodies.
  if (text.length > 65_536) return;
  const cleaned = visibleNativeMemoryText(text);
  if (!cleaned || Buffer.byteLength(cleaned) > 4096) return;
  return { id: value.id, role, text: cleaned };
}

export class NativeMemoryJournal {
  private readonly inflight = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly history: HarnessHistory,
    private readonly memory: ProjectMemory,
    private readonly now: () => number = Date.now,
  ) {}

  private source(destination: Destination, stored: NativeSource | null) {
    if (stored && (stored.owner !== destination.owner || stored.projectId !== destination.projectId))
      throw new HarnessError("notFound", 404);
    return stored;
  }

  async view(destination: Destination) {
    const id = sourceId(destination.id);
    const source = this.source(destination, decode<NativeSource>(await this.metadata.read(nativeMemoryKey(id))));
    const [policy, config, contributions] = await Promise.all([
      this.memory.policy(destination.owner, destination.projectId),
      this.memory.source(id),
      source ? this.memory.contributions(source) : undefined,
    ]);
    return {
      revision: config.revision,
      enabled: !!source && config.write === true,
      paused: config.pausedAfterSeq !== undefined,
      organizerEnabled: policy.model.enabled,
      contributed: contributions?.entries.length ?? 0,
    };
  }

  async configure(destination: Destination, revision: number, enabled: boolean) {
    const id = sourceId(destination.id),
      key = nativeMemoryKey(id);
    await this.metadata.transaction(async (tx) => {
      const previous = this.source(destination, decode<NativeSource>(await tx.get(key)));
      const config = await this.memory.source(id, tx);
      if (config.revision !== revision) throw new HarnessError("conflict", 409);
      if (previous && (config.pausedAfterSeq === undefined) === enabled) return;
      if (!previous && !enabled) return;
      const source: NativeSource = previous ?? {
        id,
        owner: destination.owner,
        projectId: destination.projectId,
        nativeId: destination.id,
        cwd: destination.cwd,
        historyBytes: 0,
        lastSeq: 0,
        archivedAt: null,
        revision: 0,
        enabledAt: this.now(),
      };
      await this.memory.configureSource(tx, source, { revision, write: true, paused: !enabled, revoke: false });
      delete source.pending;
      if (enabled) source.enabledAt = this.now();
      await save(tx, key, nativeMemoryKind, source.owner, source);
    });
    return this.view(destination);
  }

  observe(message: EngineEnvelope) {
    const { method, params } = message;
    const id = params?.threadId;
    if (this.closed || typeof id !== "string" || !nativeIdPattern.test(id) || !params) return;
    if (method !== "turn/started" && method !== "turn/completed" && method !== "item/completed") return;
    const rawTurn: unknown = params.turn;
    const turn = isRecord(rawTurn) ? rawTurn : undefined;
    const turnId = method === "item/completed" ? params.turnId : turn?.id;
    if (typeof turnId !== "string" || !itemIdPattern.test(turnId)) return;
    const observedAt = this.now();
    const completed = method === "turn/completed";
    const started = method === "turn/started";
    const raw =
      method === "item/completed" ? [params.item] : Array.isArray(turn?.items) ? turn.items.slice(0, 128) : [];
    const items = raw.flatMap((value) => {
      const valid = item(value);
      return valid ? [valid] : [];
    });
    if (method === "item/completed" && !items.length) return;
    const status = turn?.status;
    const work = (this.inflight.get(id) ?? Promise.resolve())
      .then(() => this.record(id, turnId, items, observedAt, started, completed ? status === "completed" : null))
      .catch(() => {})
      .finally(() => {
        if (this.inflight.get(id) === work) this.inflight.delete(id);
      });
    this.inflight.set(id, work);
  }

  private async record(
    nativeId: string,
    turnId: string,
    items: Item[],
    observedAt: number,
    started: boolean,
    terminal: boolean | null,
  ) {
    const id = sourceId(nativeId);
    const key = nativeMemoryKey(id);
    if (!(await this.metadata.read(key))) return;
    const queued = await this.metadata.transaction(async (tx) => {
      const source = decode<NativeSource>(await tx.get(key));
      const config = await this.memory.source(id, tx);
      if (!source || config.write !== true || config.pausedAfterSeq !== undefined || observedAt <= source.enabledAt)
        return false;
      const scope = await this.memory.scope(source);
      if (!scope || scope.projectId !== source.projectId) return false;
      const runId = identity("native-memory-turn", id, turnId);
      const recordId = "run:" + runId;
      if (await tx.get(recordId)) return false;
      const pending = source.pending;
      if (!started && pending?.turnId !== turnId) return false;
      const captured = new Map(pending?.turnId === turnId ? pending.items.map((part) => [part.id, part]) : []);
      for (const part of items) {
        if (captured.has(part.id) || captured.size < 16) captured.set(part.id, part);
      }
      if (terminal === null) {
        source.pending = {
          turnId,
          startedAt: pending?.turnId === turnId ? pending.startedAt : observedAt,
          items: [...captured.values()],
        };
        await save(tx, key, nativeMemoryKind, source.owner, source);
        return false;
      }
      delete source.pending;
      const user = [...captured.values()].filter(({ role }) => role === "user");
      const assistant = [...captured.values()].filter(({ role }) => role === "assistant").at(-1);
      const boundary =
        terminal && user.length ? await this.memory.organizationBoundary(tx, scope, source.lastSeq + 1) : null;
      if (!boundary) {
        await save(tx, key, nativeMemoryKind, source.owner, source);
        return false;
      }
      const events: HarnessHistoryEvent[] = [];
      // One evidence anchor for each user item, including a steering message in the same completed turn.
      for (const [index, part] of user.entries()) {
        const currentRun = index === 0 ? runId : identity(runId, part.id);
        const messageId = identity(currentRun, part.id);
        const assistantId = identity(currentRun, "assistant");
        const seq = ++source.lastSeq;
        events.push({
          type: "message",
          seq,
          message: {
            id: messageId,
            seq,
            runId: currentRun,
            role: "user",
            runtimeId: "codex",
            model: null,
            text: part.text,
            status: "complete",
            attachments: [],
            createdAt: pending!.startedAt,
          },
        });
        if (assistant)
          events.push({ type: "text", seq: ++source.lastSeq, messageId: assistantId, text: assistant.text });
        await save(tx, "run:" + currentRun, "memory-native-turn", source.owner, {
          owner: source.owner,
          conversationId: source.id,
          userMessageId: messageId,
          assistantMessageId: assistantId,
          status: "complete",
        });
      }
      source.historyBytes = await this.history.append(source.owner, source.id, source.historyBytes, events);
      await save(tx, key, nativeMemoryKind, source.owner, source);
      await this.memory.organizations.enqueue(tx, boundary, source.historyBytes, source.lastSeq);
      return true;
    });
    if (queued) this.memory.wake();
  }

  async close() {
    this.closed = true;
    await Promise.all(this.inflight.values());
  }
}
