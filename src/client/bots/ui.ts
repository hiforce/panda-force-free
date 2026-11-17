import { botTaskState, botTaskDecision } from "../../shared/bots/task-state.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { BotConfig, BotTask } from "../../shared/bots/contracts.js";
import { escapeHtml } from "../../shared/html.js";
import { messageHtml, messageAttributes } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";

export interface BotKey {
  id: string;
  name: string;
  expiresAt: number;
  revokedAt?: number | null;
}
export interface BotSnapshot {
  bots: BotConfig[];
  keys: BotKey[];
}
export interface BotContext {
  t: Translate;
  api<T>(path?: string, method?: string, body?: unknown): Promise<T>;
  execute(work: () => Promise<void>): Promise<void>;
  notice(message: string): void;
  reload(replace?: boolean): Promise<void>;
}
export const statusIds = {
  images: "cli.botImagesVerified",
  images_failed: "cli.botImagesFailed",
  queued: "cli.botQueued",
  running: "cli.botRunning",
  kept: "cli.botKept",
  completed: "cli.botCompleted",
  review_answered: "cli.botReviewAnswered",
  manual: "cli.botReviewAnswered",
  review: "cli.botReview",
  discarded: "cli.botDiscarded",
  callback_failed: "cli.botCallbackFailed",
  callback_unknown: "cli.botCallbackUnknown",
  suspended: "cli.botStateSuspended",
  canceled: "cli.botStateCanceled",
  execution_deferred: "cli.botExecutionDeferred",
  execution_failed: "cli.botStateError",
} as const;
export function botReasonId(value: string | null | undefined): MessageId | undefined {
  const ids = {
    imageConfirmationUnavailable: "cli.botImageConfirmationUnavailable",
    modelRateLimited: "cli.botModelRateLimited",
    modelAuthenticationFailed: "cli.botModelAuthenticationFailed",
    modelExecutionFailed: "cli.botModelExecutionFailed",
    decisionMissing: "cli.botDecisionMissing",
    "No validated decision was received": "cli.botDecisionMissing",
    "null: No validated decision was received": "cli.botDecisionMissing",
  } as const;
  return value && Object.hasOwn(ids, value) ? ids[value as keyof typeof ids] : undefined;
}
export const taskStateIds = {
  created: "cli.botStateCreated",
  running: "cli.botStateRunning",
  finished: "cli.botStateFinished",
  suspended: "cli.botStateSuspended",
  canceled: "cli.botStateCanceled",
  error: "cli.botStateError",
} as const;
const legacyDecisionIds = {
  keep: "cli.botResultKeep",
  discard: "cli.botResultDiscard",
  review: "cli.botResultReview",
  complete: "cli.botResultComplete",
} as const;
/** Historical decisions retain their localized labels; declared action labels remain caller content. */
export function botDecisionLabel(decision: string | null, t: Translate): string {
  return decision && Object.hasOwn(legacyDecisionIds, decision)
    ? t(legacyDecisionIds[decision as keyof typeof legacyDecisionIds])
    : (decision ?? t("cli.botResultPending"));
}
export function botUi(t: Translate) {
  const h = (id: MessageId) => messageHtml(id, {}, t);
  const reasonHtml = (value: string | null | undefined) => {
    const id = botReasonId(value);
    return id ? h(id) : value ? `<span data-i18n-ignore>${escapeHtml(value)}</span>` : h("cli.botUnknown");
  };
  const attributes = (name: string, id: MessageId) => messageAttributes(name, id, {}, t);
  const option = (value: string, id: MessageId) =>
    `<option value="${escapeHtml(value)}" data-pf-message="${id}">${escapeHtml(t(id as never))}</option>`;
  const optional = (value: string | null | undefined, id: MessageId) =>
    value ? `<span data-i18n-ignore>${escapeHtml(value)}</span>` : h(id);
  const icon = (name: string) => `<span class="bot-icon" aria-hidden="true">${codexIcon(name)}</span>`;
  const button = (id: MessageId, attributes = "", primary = false, name = "") =>
    `<button type="button" class="wb-button${primary ? " primary" : ""}" ${attributes}>${name ? icon(name) : ""}${h(id)}</button>`;
  const field = (id: MessageId, name: string, attributes = "", hint?: MessageId) =>
    `<label class="wb-field"><span>${h(id)}</span><input name="pf-bot-${name}" ${attributes}>${hint ? `<small>${h(hint)}</small>` : ""}</label>`;
  const badge = (task: Pick<BotTask, "status" | "failure"> | BotTask["status"]) => {
    const state = botTaskState(typeof task === "string" ? { status: task } : task);
    return `<span class="bot-status" data-status="${state}"><span aria-hidden="true"></span>${h(taskStateIds[state])}</span>`;
  };
  const outcome = (
    task: Pick<BotTask, "status"> & { decision?: BotTask["decision"]; decisionLabel?: string; reason?: string | null },
    summary = false,
  ) => {
    const decision = botTaskDecision(task);
    const message =
      decision && Object.hasOwn(legacyDecisionIds, decision)
        ? legacyDecisionIds[decision as keyof typeof legacyDecisionIds]
        : "cli.botResultPending";
    const label = task.decisionLabel
      ? `<span data-i18n-ignore>${escapeHtml(task.decisionLabel)}</span>`
      : decision && !Object.hasOwn(legacyDecisionIds, decision)
        ? `<span data-i18n-ignore>${escapeHtml(decision)}</span>`
        : h(message);
    const reason = task.reason
      ? (botReasonId(task.reason) ? t(botReasonId(task.reason)!) : task.reason).replace(/\s+/g, " ").slice(0, 400)
      : "";
    const actual = summary && decision === "complete" && !task.decisionLabel && reason;
    const content =
      summary && reason
        ? `${actual ? "" : `<span class="bot-outcome-label">${label}</span>`}<span class="bot-outcome-reason" data-i18n-ignore title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>`
        : label;
    return `<span class="bot-outcome" data-decision="${escapeHtml(decision || "pending")}">${content}</span>`;
  };
  const empty = (title: MessageId, hint: MessageId, action = "") =>
    `<div class="bot-empty">${icon("bot")}<h2>${h(title)}</h2><p>${h(hint)}</p>${action}</div>`;
  return { h, reasonHtml, attributes, option, optional, icon, button, field, badge, outcome, empty };
}
export function botDate(value: number) {
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
