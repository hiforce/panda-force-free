export type BotConnectionKind = "slack" | "gmail";
export interface BotConnectionView {
  id: string;
  name: string;
  kind: BotConnectionKind;
  state: "unverified" | "ready" | "disabled" | "error";
  revision: number;
  checkedAt: number | null;
  account?: string;
}
export type BotSource = { kind: "rss"; url: string } | { kind: "gmail"; connectionId: string; query: string };
export type BotSchedule = { kind: "interval"; minutes: number } | { kind: "daily"; time: string; timezone: string };
export interface BotIntegrationConfig {
  id: string;
  botId: string;
  name: string;
  source: BotSource;
  schedule: BotSchedule;
  instructions: string;
  enabled: boolean;
  retentionDays: number;
  delivery: { channel: boolean; slack?: { connectionId: string; channel: string } };
  mail: { mode: "draft" | "auto"; allowSenders: string[]; dailyLimit: number };
}
export interface BotSourceItem {
  id: string;
  title: string;
  text: string;
  url: string;
  publishedAt: number | null;
  digest: string;
  truncated?: boolean;
  mail?: { account?: string; threadId: string; from: string; messageId: string; autoSubmitted: boolean };
}
export type BotIntegrationRunState =
  "queued" | "collecting" | "processing" | "delivering" | "complete" | "review" | "failed" | "canceled";
export interface BotIntegrationRunView {
  id: string;
  integrationId: string;
  state: BotIntegrationRunState;
  preview: boolean;
  createdAt: number;
  completedAt: number | null;
  itemCount: number;
  taskIds: string[];
  failure?: string;
}
export interface BotIntegrationView {
  config: BotIntegrationConfig;
  revision: number;
  nextRunAt: number | null;
  lastRun: BotIntegrationRunView | null;
}
export interface BotChannelMessage {
  id: string;
  integrationId: string;
  runId: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  sources: { title: string; url: string }[];
  kind?: "digest" | "mail";
  title?: string;
  draftFailure?: string;
  reply?: {
    to: string;
    subject: string;
    text: string;
    state: "draft" | "queued" | "sent" | "unknown" | "failed";
    receipt?: string;
  };
}
