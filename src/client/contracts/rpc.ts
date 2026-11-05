import type { Conversation, EngineTurn, Goal, ConversationHistory, SessionSummary } from "../../shared/engine/types.js";
import type { NativeInput } from "../../shared/data-contracts.js";
export interface QueuedSubmission {
  id: string;
  input: readonly NativeInput[];
  clientUserMessageId?: string;
}
/** Application RPC results are independent of any engine's transport envelopes. */
export interface RpcResults {
  "thread/start": { thread: Conversation };
  "thread/resume": { thread: Conversation };
  "thread/read": { thread: Conversation };
  "thread/fork": { thread: Conversation };
  "thread/list": { data: SessionSummary[]; nextCursor?: string | null };
  "host/thread/history": { thread: SessionSummary; history: ConversationHistory & { turns: EngineTurn[] } };
  "host/thread/live": { thread?: Conversation; turn?: EngineTurn; active?: boolean; unchanged?: boolean };
  "turn/start": { turn: EngineTurn };
  "turn/steer": { turnId?: string };
  "turn/interrupt": unknown;
  "review/start": { turn: EngineTurn };
  "thread/name/set": { thread?: SessionSummary };
  "thread/delete": unknown;
  "thread/compact/start": unknown;
  "thread/queue/add": { queuedSubmission: QueuedSubmission };
  "thread/queue/delete": unknown;
  "thread/queue/list": { queuedSubmissions: QueuedSubmission[] };
  "thread/goal/set": { goal?: Goal };
  "thread/goal/clear": { goal?: Goal };
  "account/logout": unknown;
}
export type ClientRpc = <M extends keyof RpcResults>(
  method: M,
  params?: Record<string, unknown>,
) => Promise<RpcResults[M]>;
export interface TransportHandlers {
  envelope(message: unknown): void;
  status(kind: string, text: string): void;
  disrupted(): void;
}
