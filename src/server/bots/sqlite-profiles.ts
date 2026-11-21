import { newBotRecord, editedBotRecord } from "./profile-record.js";
import { Database } from "bun:sqlite";
import { BotError, type BotConfig } from "../../shared/bots/contracts.js";
import { BotAvatars } from "./avatars.js";

type Row = { data: string };
export class SQLiteBotProfiles {
  constructor(
    private readonly db: Database,
    readonly avatars: BotAvatars,
    private readonly sessions: Set<string>,
  ) {}
  bots(owner: string): BotConfig[] {
    return this.db
      .query<Row, [string]>("SELECT data FROM bots WHERE owner=? ORDER BY rowid DESC")
      .all(owner)
      .map((r) => JSON.parse(r.data));
  }
  bot(owner: string, id: string): BotConfig {
    const r = this.db
      .query<Row, [string, string]>("SELECT data FROM bots WHERE owner=? AND (id=?2 OR code=?2)")
      .get(owner, id);
    if (!r) throw new BotError("notFound", 404);
    return JSON.parse(r.data);
  }
  saveBot(bot: BotConfig) {
    if (this.db.query("SELECT 1 FROM bot_schema_meta WHERE id=?").get("deleted-profile:" + bot.owner + ":" + bot.id))
      throw new BotError("notFound", 404);
    if (bot.avatar?.type === "image") this.avatars.read(bot.owner, bot.avatar.id);
    try {
      this.db
        .query("INSERT INTO bots VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(bot.id, bot.owner, bot.code, JSON.stringify(bot));
    } catch {
      throw new BotError("duplicateCode", 409);
    }
    if (bot.sessionId) {
      this.db.query("INSERT OR IGNORE INTO bot_sessions VALUES(?)").run(bot.sessionId);
      this.sessions.add(bot.sessionId);
    }
    return bot;
  }
  createBot(owner: string, value: Record<string, unknown>) {
    if (this.bots(owner).length >= 100) throw new BotError("limit", 429);
    return this.saveBot(newBotRecord(owner, value));
  }
  updateBot(owner: string, id: string, value: Record<string, unknown>) {
    return this.saveBot(editedBotRecord(this.bot(owner, id), value));
  }
  configureBot(owner: string, value: Record<string, unknown>, id?: string, image?: { id: string; bytes: Uint8Array }) {
    return this.db
      .transaction(() => {
        if (id) this.bot(owner, id);
        if (image) this.avatars.put(owner, image.id, image.bytes);
        const bot = id ? this.updateBot(owner, id, value) : this.createBot(owner, value);
        this.avatars.prune(owner);
        return bot;
      })
      .immediate();
  }
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }
  prepareSession(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const current = this.bot(owner, id);
        if ((current.sessionTasks ?? 0) >= 100) {
          current.sessionTasks = 0;
          current.sessionId = null;
        }
        current.sessionTasks = (current.sessionTasks ?? 0) + 1;
        return this.saveBot(current);
      })
      .immediate();
  }
  setSession(owner: string, id: string, sessionId: string, runtimeId?: string) {
    return this.db
      .transaction(() => {
        const current = this.bot(owner, id);
        return runtimeId && (current.runtimeId ?? "codex") !== runtimeId
          ? current
          : this.saveBot({ ...current, sessionId });
      })
      .immediate();
  }
}
