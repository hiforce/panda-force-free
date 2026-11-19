import { createHash } from "node:crypto";
import type { BotChannelMessage, BotSourceItem } from "../../../shared/bots/integrations.js";
import type { BotWorkspaceRecord, BotWorkspaceWrite } from "../workspace/storage.js";

const namespace = Buffer.from("7f4e846d6d10471ba8f80d6db3724b59", "hex");
/** RFC4122 name-based identities survive retries and restarts without adding a second provider message. */
export function botDeliveryIdentity(name: string) {
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
export interface BotChannelRecord extends BotChannelMessage {
  source?: BotSourceItem;
  connectionId?: string;
  generation: number;
  kind: "digest" | "mail";
  title: string;
  draftFailure?:
    "invalidDraft" | "reviewRequired" | "autoSubmitted" | "senderNotAllowed" | "sourceTruncated" | "dailyLimit";
}
export interface BotIntegrationDelivery {
  id: string;
  kind: "slack" | "gmail";
  integrationId: string;
  runId: string;
  generation: number;
  part: number;
  taskId: string;
  connectionId: string;
  channelMessageId?: string;
  automatic: boolean;
  approvedBy?: string;
  channel?: string;
  text: string;
  sources: { title: string; url: string }[];
  source?: BotSourceItem;
  attempts: number;
  lease?: string;
  dispatchedAt?: number;
  failure?: string;
  receipt?: { id: string; channel?: string; threadId?: string };
}
export function botChannelView(
  value: BotChannelRecord,
): BotChannelMessage & { kind: "digest" | "mail"; title: string; draftFailure?: BotChannelRecord["draftFailure"] } {
  const { id, integrationId, runId, text, createdAt, expiresAt, sources, reply, kind, title, draftFailure } = value;
  return { id, integrationId, runId, text, createdAt, expiresAt, sources, reply, kind, title, draftFailure };
}
export function botDeliveryWrite(
  row: BotWorkspaceRecord,
  data: BotIntegrationDelivery,
  state: string,
  dueAt: number | null,
): BotWorkspaceWrite {
  return { kind: "delivery", id: row.id, botId: row.botId, expiresAt: row.expiresAt, dueAt, state, data };
}
