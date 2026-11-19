import { BotError } from "../../../shared/bots/contracts.js";
import type { BotWorkspaceStorage, BotWorkspaceKind, BotWorkspaceBatch } from "../workspace/storage.js";

/** The quota record is checked in the same transaction as creation, including concurrent peers. */
export async function botWorkspaceSlot(
  storage: BotWorkspaceStorage,
  owner: string,
  kind: "connection" | "integration",
  botId: string,
): Promise<BotWorkspaceBatch> {
  const key = { kind: "control" as BotWorkspaceKind, id: kind + ":" + botId },
    row = await storage.get<{ count: number }>(owner, key),
    count = row?.data.count ?? (await storage.list(owner, kind, { botId, limit: 100 })).length;
  if (!Number.isSafeInteger(count) || count < 0) throw new BotError("unavailable", 503);
  if (count >= 100) throw new BotError(kind === "connection" ? "connectionLimit" : "integrationLimit", 429);
  return {
    checks: [{ ...key, version: row?.version ?? null }],
    puts: [{ ...key, botId, state: "quota", dueAt: null, expiresAt: null, data: { count: count + 1 } }],
  };
}
