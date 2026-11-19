import { isRecord } from "../records.js";

export class BotError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
/** Business action identifiers belong to an individual task, not a product-wide task taxonomy. */
export type BotDecision = string;
export type BotTaskState = "created" | "running" | "finished" | "suspended" | "canceled" | "error";
export type BotCallbackStatus =
  "not-sent" | "not-required" | "not-configured" | "pending" | "succeeded" | "failed" | "unknown";
export type BotTaskStatus =
  | "queued"
  | "running"
  | "kept"
  | "review"
  | "discarded"
  | "completed"
  | "callback_failed"
  | "callback_unknown"
  | "suspended"
  | "canceled";
export const BOT_AVATAR_CHOICES = ["panda", "cat", "dog", "fox", "owl", "rabbit", "bear", "tiger", "penguin"] as const;
// Existing saved icons remain valid when the picker presents the new animal collection.
export const BOT_AVATAR_ICONS = [
  ...BOT_AVATAR_CHOICES,
  "bot",
  "sparkles",
  "compass",
  "shield",
  "pencil",
  "globe",
] as const;
export const BOT_AVATAR_TONES = ["accent", "success", "warning"] as const;
export type BotAvatar =
  | { type: "icon"; icon: (typeof BOT_AVATAR_ICONS)[number]; tone: (typeof BOT_AVATAR_TONES)[number] }
  | { type: "image"; id: string };
export const DEFAULT_BOT_AVATAR = { type: "icon", icon: "panda", tone: "accent" } as const;
export interface BotPersona {
  role: string;
  traits: string;
  voice: string;
  motto: string;
}
export interface BotConfig {
  id: string;
  owner: string;
  code: string;
  name: string;
  model: string;
  instructions: string;
  active: boolean;
  callbackHosts: string[];
  sessionId: string | null;
  sessionTasks?: number;
  executionRetryAt?: number;
  avatar?: BotAvatar;
  persona?: BotPersona;
  createdAt: number;
}
export function botAvatar(value: unknown): BotAvatar {
  if (!isRecord(value)) throw new BotError("invalidAvatar");
  if (
    value.type === "icon" &&
    Object.keys(value).every((k) => ["type", "icon", "tone"].includes(k)) &&
    BOT_AVATAR_ICONS.includes(value.icon as never) &&
    BOT_AVATAR_TONES.includes(value.tone as never)
  )
    return {
      type: "icon",
      icon: value.icon as (typeof BOT_AVATAR_ICONS)[number],
      tone: value.tone as (typeof BOT_AVATAR_TONES)[number],
    };
  if (
    value.type === "image" &&
    Object.keys(value).every((k) => ["type", "id"].includes(k)) &&
    typeof value.id === "string" &&
    /^[a-f0-9]{64}$/.test(value.id)
  )
    return { type: "image", id: value.id };
  throw new BotError("invalidAvatar");
}
export function botPersona(value: unknown): BotPersona {
  if (!isRecord(value) || Object.keys(value).some((k) => !["role", "traits", "voice", "motto"].includes(k)))
    throw new BotError("invalidPersona");
  return {
    role: botText(value.role ?? "", 120, true),
    traits: botText(value.traits ?? "", 2000, true),
    voice: botText(value.voice ?? "", 1000, true),
    motto: botText(value.motto ?? "", 160, true),
  };
}
export interface BotCallback {
  url: string;
  method: "POST";
  body: Record<string, unknown>;
  success?: { path: string; equals: string | number | boolean };
}
export interface BotAction {
  id: string;
  label: string;
  when?: string;
  callback?: BotCallback;
}
export interface BotReviewOption {
  id: string;
  label: string;
  actionId?: string;
}
export interface BotReview {
  id: string;
  question: string;
  options: BotReviewOption[];
}
export interface BotReviewAnswer {
  reviewId: string;
  optionId?: string;
  message?: string;
}
export interface BotTaskInput {
  title?: string;
  externalTaskId: string;
  instructions: string;
  input: { text: string; images: string[] };
  actions?: BotAction[];
  /** Compatibility with the original PIM integration. New integrations declare task-scoped actions. */
  callbacks?: { discard: BotCallback };
}
export interface BotTask {
  id: string;
  owner: string;
  botId: string;
  title?: string;
  externalTaskId: string;
  status: BotTaskStatus;
  state?: BotTaskState;
  callbackStatus?: BotCallbackStatus;
  failure?: "execution";
  input: BotTaskInput;
  decision: BotDecision | null;
  decisionLabel?: string;
  review?: BotReview;
  reviewHistory?: Array<BotReview & { answer: Omit<BotReviewAnswer, "reviewId"> & { at: number } }>;
  reason: string | null;
  imageEvidence?: { images: string[]; observations: string; verifiedAt: number };
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  runId: string | null;
}
export type BotDirectoryEntry = Pick<BotConfig, "id" | "name" | "active" | "avatar"> & { role?: string };
export interface BotTaskSummary {
  id: string;
  botId: string;
  title?: string;
  externalTaskId: string;
  status: BotTaskStatus;
  state?: BotTaskState;
  callbackStatus?: BotCallbackStatus;
  failure?: "execution";
  decision?: BotDecision | null;
  decisionLabel?: string;
  summary: string;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotBulkRetryRequest {
  id: string;
  taskIds: string[];
}
export interface BotBulkDeleteResult {
  requested: number;
  deleted: number;
  alreadyDeleted: number;
  blocked: { id: string; code: "notFound" | "callbackInFlight" }[];
  interrupted: string[];
}
export interface BotBulkRetryResult {
  id: string;
  requested: number;
  queued: number;
  skipped: number;
}
export interface BotQueueSnapshot {
  bots: BotDirectoryEntry[];
  tasks: BotTaskSummary[];
  page?: number;
  anchor?: number;
  limit?: number;
  total?: number;
  counts?: Record<string, number>;
}
export function botText(value: unknown, max: number, optional = false): string {
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim()))
    throw new BotError("invalidInput");
  return value.trim();
}
export function botHttps(value: unknown): URL {
  const url = new URL(botText(value, 4096));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443"))
    throw new BotError("invalidUrl");
  return url;
}
export function botTaskInput(value: unknown): BotTaskInput {
  if (!isRecord(value) || !isRecord(value.input)) throw new BotError("invalidInput");
  const images = value.input.images ?? [];
  if (!Array.isArray(images) || images.length > 2) throw new BotError("invalidImages");
  const result: BotTaskInput = {
    externalTaskId: botText(value.externalTaskId, 256),
    instructions: botText(value.instructions, 32000),
    input: { text: botText(value.input.text, 64000), images: images.map((image) => botHttps(image).href) },
  };
  if (value.title !== undefined) result.title = botText(value.title, 240);
  if (value.actions !== undefined) {
    if (value.callbacks !== undefined || !Array.isArray(value.actions) || value.actions.length > 16)
      throw new BotError("invalidActions");
    const ids = new Set<string>();
    result.actions = value.actions.map((action) => {
      if (
        !isRecord(action) ||
        Object.keys(action).some((k) => !["id", "label", "when", "callback"].includes(k)) ||
        typeof action.id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(action.id) ||
        ["review", "complete", "cancel", "retry", "suspend", "resume"].includes(action.id) ||
        ids.has(action.id)
      )
        throw new BotError("invalidActions");
      ids.add(action.id);
      return {
        id: action.id,
        label: botText(action.label, 120),
        ...(action.when !== undefined ? { when: botText(action.when, 2000) } : {}),
        ...(action.callback !== undefined ? { callback: botCallback(action.callback) } : {}),
      };
    });
  }
  if (value.callbacks !== undefined) {
    if (!isRecord(value.callbacks) || !isRecord(value.callbacks.discard)) throw new BotError("invalidCallback");
    result.callbacks = { discard: botCallback(value.callbacks.discard) };
  }
  return result;
}

function botCallback(value: unknown): BotCallback {
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => !["url", "method", "body", "success"].includes(k)) ||
    value.method !== "POST" ||
    !isRecord(value.body) ||
    JSON.stringify(value.body).length > 16000
  )
    throw new BotError("invalidCallback");
  const callback: BotCallback = {
    url: botHttps(value.url).href,
    method: "POST",
    body: JSON.parse(JSON.stringify(value.body)),
  };
  if (value.success !== undefined) {
    const s = value.success;
    if (
      !isRecord(s) ||
      Object.keys(s).some((k) => !["path", "equals"].includes(k)) ||
      typeof s.path !== "string" ||
      !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){0,7}$/.test(s.path) ||
      !["string", "number", "boolean"].includes(typeof s.equals)
    )
      throw new BotError("invalidCallback");
    callback.success = { path: s.path, equals: s.equals as string | number | boolean };
  }
  return callback;
}
