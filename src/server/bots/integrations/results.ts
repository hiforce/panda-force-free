import { isRecord } from "../../../shared/records.js";
import { BotError, type BotTask } from "../../../shared/bots/contracts.js";
import type { BotWorkspaceWrite } from "../workspace/storage.js";
import { BotIntegrationLease } from "./run-lease.js";
import type { BotIntegrationResultSink } from "./processing.js";
import { botDeliveryIdentity, type BotChannelRecord, type BotIntegrationDelivery } from "./delivery-records.js";
import { serverTranslator } from "../../i18n/messages.js";

export function botMailDraft(reason: string): { reply: string; needsReview: boolean } | null {
  let value: unknown;
  try {
    value = JSON.parse(reason);
  } catch {
    return null;
  }
  return isRecord(value) &&
    Object.keys(value).every((key) => ["reply", "needsReview"].includes(key)) &&
    typeof value.reply === "string" &&
    !!value.reply.trim() &&
    value.reply.length <= 2500 &&
    typeof value.needsReview === "boolean"
    ? { reply: value.reply.trim(), needsReview: value.needsReview }
    : null;
}
/** A validated task result creates its channel entry and delivery intents in one fenced transaction. */
export class BotIntegrationResults implements BotIntegrationResultSink {
  async apply(lease: BotIntegrationLease, part: number, task: BotTask) {
    const current = await lease.current();
    if (!current) return false;
    if (current.run.data.parts[part]?.applied) return true;
    const run = current.run,
      config = run.data.config,
      mail = config.source.kind === "gmail",
      items = run.data.items.filter((item) => run.data.parts[part]!.itemIds.includes(item.id)),
      first = items[0];
    if (!items.length || !task.reason || task.botId !== run.botId || task.id !== run.data.parts[part]?.taskId)
      throw new BotError("invalidRun");
    const createdAt = task.updatedAt,
      identity = botDeliveryIdentity(run.id + ":" + part + ":channel"),
      channelId = String(createdAt).padStart(16, "0") + ":" + identity,
      expiresAt = createdAt + config.retentionDays * 86400000,
      draft = mail ? botMailDraft(task.reason) : null,
      sources = items.map(({ title, url }) => ({ title, url })),
      puts: BotWorkspaceWrite[] = [];
    let draftFailure: BotChannelRecord["draftFailure"];
    if (mail) {
      if (!draft) draftFailure = "invalidDraft";
      else if (draft.needsReview) draftFailure = "reviewRequired";
      else if (first!.mail?.autoSubmitted) draftFailure = "autoSubmitted";
      else if (first!.truncated) draftFailure = "sourceTruncated";
      else if (!config.mail.allowSenders.includes(first!.mail?.from ?? "")) draftFailure = "senderNotAllowed";
    }
    const auto = mail && config.mail.mode === "auto" && !draftFailure && !!current.config.data.autoConsent;
    const message: BotChannelRecord = {
      id: channelId,
      integrationId: run.data.view.integrationId,
      runId: run.id,
      text: mail ? first!.text : task.reason,
      createdAt,
      expiresAt,
      sources,
      generation: run.data.generation,
      kind: mail ? "mail" : "digest",
      title: mail ? first!.title : config.name,
      ...(mail
        ? {
            source: first,
            connectionId: config.source.kind === "gmail" ? config.source.connectionId : "",
            draftFailure,
            reply: {
              to: first!.mail?.from ?? "",
              subject: first!.title,
              text: draft?.reply ?? "",
              state: auto ? "queued" : "draft",
            },
          }
        : {}),
    };
    if (config.delivery.channel || mail)
      puts.push({
        kind: "channel-message",
        id: channelId,
        botId: run.botId,
        state: "active",
        dueAt: null,
        expiresAt,
        data: message,
      });
    const delivery = (
      kind: "slack" | "gmail",
      connectionId: string,
      text: string,
      automatic: boolean,
      channel?: string,
    ) => {
      const id = run.id + ":" + part + ":" + kind,
        data: BotIntegrationDelivery = {
          id: botDeliveryIdentity(id),
          kind,
          integrationId: run.data.view.integrationId,
          runId: run.id,
          generation: run.data.generation,
          part,
          taskId: task.id,
          connectionId,
          channelMessageId: config.delivery.channel || mail ? channelId : undefined,
          automatic,
          text,
          sources,
          attempts: 0,
          ...(channel ? { channel } : {}),
          ...(kind === "gmail" ? { source: first } : {}),
        };
      puts.push({ kind: "delivery", id, botId: run.botId, state: "queued", dueAt: Date.now(), expiresAt, data });
    };
    if (config.delivery.slack && (!mail || draft)) {
      const t = serverTranslator(run.data.locale),
        text = mail
          ? t("bots.mailDraftNotice", { sender: first!.mail?.from ?? "", subject: first!.title }) +
            "\n\n" +
            draft!.reply
          : config.name + "\n\n" + task.reason;
      delivery("slack", config.delivery.slack.connectionId, text, false, config.delivery.slack.channel);
    }
    if (auto && config.source.kind === "gmail") delivery("gmail", config.source.connectionId, draft!.reply, true);
    return lease.transact(({ run: freshRun }) => ({
      run: {
        ...freshRun.data,
        parts: freshRun.data.parts.map((entry, index) => (index === part ? { ...entry, applied: true } : entry)),
      },
      dueAt: Date.now() + 30000,
      checks: puts.map((row) => ({ kind: row.kind, id: row.id, version: null })),
      puts,
    }));
  }
}
