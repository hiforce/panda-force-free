import { createHash } from "node:crypto";
import { BotError } from "../../../shared/bots/contracts.js";
import type { BotSourceItem, BotSource } from "../../../shared/bots/integrations.js";
import type { BotWorkspaceWrite } from "../workspace/storage.js";
import { BotIntegrationLease } from "./run-lease.js";
import { collectBotFeed } from "./feed.js";
import { collectGmailInbox } from "./mail.js";
import { BotProviders, BotProviderError } from "./providers.js";
import type { BotIntegrationRunRecord } from "./run-records.js";

export function botSourceLedgerId(
  integrationId: string,
  item: Pick<BotSourceItem, "id" | "digest">,
  source: BotSource,
) {
  const identity =
    source.kind === "gmail"
      ? [source.kind, source.connectionId, item.id]
      : [source.kind, source.url, item.id, item.digest];
  return integrationId + ":" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export interface BotIntegrationSourcePorts {
  feed: typeof collectBotFeed;
  inbox: typeof collectGmailInbox;
}
export const botIntegrationSourcePorts: BotIntegrationSourcePorts = { feed: collectBotFeed, inbox: collectGmailInbox };

/** Raw capture, source deduplication and cursor advancement commit together before any model or external delivery. */
export async function collectBotIntegration(
  lease: BotIntegrationLease,
  providers: BotProviders,
  signal: AbortSignal,
  ports = botIntegrationSourcePorts,
) {
  const current = await lease.current();
  if (!current) return;
  const { config, run } = current,
    source = run.data.config.source;
  try {
    let items: BotSourceItem[],
      limited: boolean,
      cursor = config.data.cursor;
    if (source.kind === "rss") {
      const result = await ports.feed(source.url, run.data.view.preview ? {} : cursor, signal);
      items = result.items;
      limited = result.limited;
      cursor = result.cursor;
    } else {
      const result = await ports.inbox(
        providers,
        lease.owner,
        source.connectionId,
        source.query,
        config.data.sourceSinceAt ?? config.data.createdAt,
        signal,
        run.data.view.preview ? "" : (cursor.pageToken ?? ""),
        run.data.view.preview
          ? async () => false
          : async (id) =>
              !!(await lease.storage.get(lease.owner, {
                kind: "source-item",
                id: botSourceLedgerId(config.id, { id, digest: "" }, source),
              })),
      );
      items = result.items;
      limited = result.limited;
      cursor = { pageToken: result.nextPageToken };
    }
    signal.throwIfAborted();
    const captures: BotSourceItem[] = [],
      ledgers: BotWorkspaceWrite[] = [];
    for (const item of items.slice(0, 100)) {
      const id = botSourceLedgerId(config.id, item, source);
      if (!run.data.view.preview && (await lease.storage.get(lease.owner, { kind: "source-item", id }))) continue;
      captures.push(item);
      if (!run.data.view.preview)
        ledgers.push({
          kind: "source-item",
          id,
          botId: run.botId,
          state: "captured",
          dueAt: null,
          expiresAt: Date.now() + 365 * 86400000,
          data: { runId: run.id },
        });
    }
    const chunks = source.kind === "rss" ? 4 : 1;
    await lease.transact(({ run: freshRun, config: freshConfig }) => {
      const done = freshRun.data.view.preview || !captures.length,
        view = {
          ...freshRun.data.view,
          itemCount: captures.length,
          state: done ? ("complete" as const) : ("processing" as const),
          completedAt: done ? Date.now() : null,
        },
        data: BotIntegrationRunRecord = {
          ...freshRun.data,
          lease: undefined,
          view,
          items: captures,
          limited,
          parts: [],
        };
      if (!done)
        for (let index = 0; index < captures.length; index += chunks)
          data.parts.push({ itemIds: captures.slice(index, index + chunks).map((i) => i.id), applied: false });
      return {
        run: data,
        dueAt: done ? null : Date.now(),
        config: {
          data: {
            ...freshConfig.data,
            ...(!view.preview ? { cursor } : {}),
            pendingRun: done ? null : freshRun.id,
            lastRun: view,
          },
          dueAt: done ? (freshConfig.data.resumeAt ?? null) : null,
        },
        checks: ledgers.map((entry) => ({ kind: entry.kind, id: entry.id, version: null })),
        puts: ledgers,
      };
    });
  } catch (error) {
    const code =
      error instanceof BotError ? error.code : error instanceof BotProviderError ? error.code : "sourceUnavailable";
    await lease.transact(({ run: freshRun, config: freshConfig }) => {
      const view = { ...freshRun.data.view, state: "failed" as const, completedAt: Date.now(), failure: code };
      return {
        run: { ...freshRun.data, lease: undefined, view, failure: code },
        dueAt: null,
        config: {
          data: { ...freshConfig.data, pendingRun: null, lastRun: view, failure: code },
          dueAt:
            freshRun.data.view.preview || freshRun.data.manual
              ? (freshConfig.data.resumeAt ?? null)
              : Date.now() + 300000,
          state: freshConfig.data.config.enabled ? "error" : "paused",
        },
      };
    });
  }
}
