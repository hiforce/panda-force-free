import type { BotRepository } from "../repository.js";
import type { BotWorkspaceOverview, BotWorkspaceCard } from "../../../shared/bots/workspace.js";

/** Counts come from all retained records, independent of task-list pagination or search. */
export async function botWorkspaceOverview(store: BotRepository, owner: string): Promise<BotWorkspaceOverview> {
  const [bots, tasks, integrations] = await Promise.all([
    store.bots(owner),
    store.botCounts(owner),
    store.workspace.counts(owner, "integration"),
  ]);
  const cards: BotWorkspaceCard[] = bots.map((bot) => ({
    bot: {
      id: bot.id,
      code: bot.code,
      name: bot.name,
      active: bot.active,
      model: bot.model,
      avatar: bot.avatar,
      persona: bot.persona,
    },
    counts: tasks[bot.id] ?? {},
    integrations: {
      enabled: (integrations[bot.id]?.enabled ?? 0) + (integrations[bot.id]?.error ?? 0),
      total: Object.values(integrations[bot.id] ?? {}).reduce((a, b) => a + b, 0),
      attention: integrations[bot.id]?.error ?? 0,
    },
  }));
  return {
    cards,
    counts: {
      bots: bots.length,
      running: cards.reduce((n, c) => n + (c.counts.running ?? 0), 0),
      queued: cards.reduce((n, c) => n + (c.counts.created ?? 0), 0),
      attention: cards.reduce((n, c) => n + (c.counts.suspended ?? 0) + (c.counts.error ?? 0), 0),
      integrations: cards.reduce((n, c) => n + c.integrations.enabled, 0),
    },
  };
}
