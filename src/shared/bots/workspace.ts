import type { BotConfig, BotTaskState } from "./contracts.js";
import type { CreationMaterial, CreationSkillSelection } from "../creation/contracts.js";
import type { SessionSkillSummary } from "../session-skills.js";

export type BotNavigationItem = Pick<BotConfig, "id" | "name" | "avatar">;

export interface BotWorkspaceCard {
  bot: Pick<BotConfig, "id" | "code" | "name" | "model" | "active" | "avatar" | "persona">;
  counts: Partial<Record<BotTaskState, number>>;
  integrations: { enabled: number; total: number; attention: number };
}
export interface BotWorkspaceOverview {
  cards: BotWorkspaceCard[];
  counts: { bots: number; running: number; queued: number; attention: number; integrations: number };
}
export type BotChatFailure = "interrupted" | "rateLimited" | "authentication" | "unavailable" | "failed";
export interface BotChatMessage {
  id: string;
  sequence: number;
  generation: number;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  status: "queued" | "running" | "complete" | "error" | "canceled";
  failure?: BotChatFailure;
  requestId?: string;
  materials?: CreationMaterial[];
  skills?: SessionSkillSummary[];
}
export interface BotChatSnapshot {
  generation: number;
  messages: BotChatMessage[];
  hasMore: boolean;
  busy: boolean;
  cleanup: "ready" | "pending" | "blocked";
  cursor?: string;
  replace?: boolean;
}
export type BotChatRead = BotChatSnapshot | { unchanged: true; cursor: string };
export interface BotChatSubmission {
  requestId: string;
  generation: number;
  text: string;
  attachments?: { materialId: string }[];
  selections?: CreationSkillSelection[];
}
export interface BotChatClear {
  requestId: string;
  generation: number;
}
