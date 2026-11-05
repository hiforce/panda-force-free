import type { EngineQuestion } from "./questions.js";
import type { ApprovalModel, NativeTurn } from "../data-contracts.js";
import type { RpcId, RpcRecord } from "../rpc-types.js";
import type { Conversation, SessionSummary } from "./types.js";

import type { EngineOperation, EngineDescriptor } from "./primitives.js";
export type { EngineCapability, EngineOperation } from "./primitives.js";
export type { EngineDescriptor } from "./primitives.js";
/** PandaForce v1 event vocabulary is stable across native transports. */
export interface EngineEventParameters extends RpcRecord {
  threadId?: string;
  turnId?: string;
  threadName?: string;
  name?: string;
  requestId?: RpcId;
  item?: NativeTurn["items"][number];
  turn?: { id: string };
  status?: unknown;
}
export interface EngineEnvelope {
  id?: RpcId;
  method?: string;
  params?: EngineEventParameters;
  result?: unknown;
  error?: unknown;
  surface?: { kind: "approval"; model: ApprovalModel } | { kind: "questions"; questions: EngineQuestion[] };
}
export type EngineEvent =
  | { kind: "notification"; engineId: string; envelope: EngineEnvelope }
  | { kind: "approval"; engineId: string; envelope: EngineEnvelope & { id: RpcId } }
  | { kind: "connected"; engineId: string; info: unknown; storage?: { sessionsRoot?: string } }
  | { kind: "disconnected"; engineId: string; code: number | null; signal: string | null };
export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: string | null;
}
export interface EngineSessions {
  list(options?: { cursor?: string; limit?: number }): Promise<SessionPage>;
  read(id: string): Promise<Conversation>;
  create(options?: { cwd?: string; model?: string }): Promise<Conversation>;
  resume(id: string): Promise<Conversation>;
}
export interface EngineDriver {
  readonly descriptor: EngineDescriptor;
  readonly sessions: EngineSessions;
  readonly connected: boolean;
  execute(operation: EngineOperation, params?: RpcRecord): Promise<unknown>;
  validateResponse(id: RpcId, result?: unknown, error?: unknown): void;
  respond(id: RpcId, result?: unknown, error?: unknown): void;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  start(): void;
  stop(signal?: "SIGTERM" | "SIGKILL"): void;
  fullyStopped(): boolean;
  cancelRestart(): void;
  rejectPending(error: Error): void;
}
export interface CommandToolDescriptor {
  readonly id: string;
  readonly name: string;
  readonly kind: "command-tool";
}
export interface CommandTool {
  readonly descriptor: CommandToolDescriptor;
  execute(
    arguments_: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
