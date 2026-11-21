import type { BotChatMessage } from "../../../shared/bots/workspace.js";
import type { BotConfig } from "../../../shared/bots/contracts.js";
import type { BotWorkspaceRecord, BotWorkspaceWrite } from "./storage.js";
import type { BotChatContext } from "./chat-context.js";

export interface BotChatState {
  generation: number;
  sequence: number;
  sessionId: string | null;
  runtimeId?: string;
  toolset?: "materials-v1";
  updatedAt: number;
  pending: null | {
    requestId: string;
    userId: string;
    assistantId: string;
    bot: Pick<BotConfig, "name" | "runtimeId" | "model" | "effort" | "instructions" | "persona">;
    lease: string | null;
    runId?: string;
    context?: BotChatContext;
    locale?: string;
  };
}
export interface BotChatReceipt {
  action: "send" | "clear";
  generation: number;
  fingerprint?: string;
  userId?: string;
}
export type BotChatCleanup = (
  | { type: "engine"; sessionId: string; model: string; runtimeId?: string }
  | { type: "records"; throughGeneration: number }
) & { lease?: string; attempts?: number; failure?: "cleanupUnavailable" | "providerDeletionUnavailable" };

export const chatPrefix = (botId: string, generation: number) =>
  botId + ":" + String(generation).padStart(12, "0") + ":";
export const chatMessageId = (botId: string, generation: number, sequence: number) =>
  chatPrefix(botId, generation) + String(sequence).padStart(16, "0");
export const chatReceiptPrefix = (botId: string, generation: number) =>
  botId + ":send:" + String(generation).padStart(12, "0") + ":";
export const chatWrite = (
  botId: string,
  state: BotChatState,
  status = state.pending ? "queued" : "idle",
  dueAt: number | null = null,
): BotWorkspaceWrite => ({
  kind: "chat",
  id: botId,
  botId,
  state: status,
  dueAt,
  expiresAt: null,
  data: state,
});
export const messageWrite = (botId: string, value: BotChatMessage): BotWorkspaceWrite => ({
  kind: "chat-message",
  id: value.id,
  botId,
  state: value.status,
  dueAt: null,
  expiresAt: null,
  data: value,
});
export const unchangedWrite = <T>(
  row: BotWorkspaceRecord<T>,
  data: T,
  extra: Partial<BotWorkspaceWrite> = {},
): BotWorkspaceWrite => ({
  kind: row.kind,
  id: row.id,
  botId: row.botId,
  state: row.state,
  dueAt: row.dueAt,
  expiresAt: row.expiresAt,
  data,
  ...extra,
});
