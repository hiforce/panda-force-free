import { duplicateBotRecord as duplicate } from "./mysql-context.js";
import { SQL } from "bun";
import { BotError, type BotConfig } from "../../shared/bots/contracts.js";
import { newBotRecord, editedBotRecord } from "./profile-record.js";
import { MySQLBotContext } from "./mysql-context.js";
export class MySQLBotProfiles {
  readonly avatars = {
    read: (owner: string, id: string) => this.context.operation(() => this.avatar(this.context.pool, owner, id)),
  };
  constructor(
    private readonly context: MySQLBotContext,
    private readonly sessions: Set<string>,
  ) {}
  async readBot(sql: SQL, owner: string, id: string, lock = false): Promise<BotConfig> {
    const rows = await sql.unsafe(
      `SELECT data FROM panda_force_bots WHERE owner=? AND (id=? OR code=?)${lock ? " FOR UPDATE" : ""}`,
      [owner, id, id],
    );
    if (!rows.length) throw new BotError("notFound", 404);
    return JSON.parse(rows[0].data);
  }
  bots(owner: string): Promise<BotConfig[]> {
    return this.context.operation(async () =>
      (
        await this.context
          .pool`SELECT data FROM panda_force_bots WHERE owner=${owner} ORDER BY JSON_EXTRACT(data,'$.createdAt') DESC,id`
      ).map((r: { data: string }) => JSON.parse(r.data)),
    );
  }
  bot(owner: string, id: string) {
    return this.context.operation(() => this.readBot(this.context.pool, owner, id));
  }
  async avatar(sql: SQL, owner: string, id: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new BotError("notFound", 404);
    const rows = await sql`SELECT bytes FROM panda_force_bot_avatars WHERE owner=${owner} AND id=${id}`;
    if (!rows.length) throw new BotError("notFound", 404);
    return rows[0].bytes;
  }
  async put(sql: SQL, bot: BotConfig) {
    if (bot.avatar?.type === "image") await this.avatar(sql, bot.owner, bot.avatar.id);
    const prior = await sql`SELECT owner,code FROM panda_force_bots WHERE id=${bot.id} FOR UPDATE`;
    if (prior.length) {
      if (prior[0].owner !== bot.owner || prior[0].code !== bot.code) throw new BotError("invalidInput");
      await sql`UPDATE panda_force_bots SET data=${JSON.stringify(bot)} WHERE id=${bot.id}`;
    } else
      try {
        await sql`INSERT INTO panda_force_bots(id,owner,code,data) VALUES(${bot.id},${bot.owner},${bot.code},${JSON.stringify(bot)})`;
      } catch (error) {
        if (duplicate(error)) throw new BotError("duplicateCode", 409);
        throw error;
      }
    if (bot.sessionId) await sql`INSERT IGNORE INTO panda_force_bot_sessions(id) VALUES(${bot.sessionId})`;
    return bot;
  }
  createBot(owner: string, value: Record<string, unknown>) {
    return this.configureBot(owner, value);
  }
  updateBot(owner: string, id: string, value: Record<string, unknown>) {
    return this.configureBot(owner, value, id);
  }
  async configureBot(
    owner: string,
    value: Record<string, unknown>,
    id?: string,
    image?: { id: string; bytes: Uint8Array },
  ) {
    const result = await this.context.transaction(async (sql) => {
      await this.context.lock(sql, "owner:" + owner);
      const current = id ? await this.readBot(sql, owner, id, true) : null;
      if (!current && Number((await sql`SELECT COUNT(*) n FROM panda_force_bots WHERE owner=${owner}`)[0].n) >= 100)
        throw new BotError("limit", 429);
      if (image)
        await sql`INSERT IGNORE INTO panda_force_bot_avatars(owner,id,bytes) VALUES(${owner},${image.id},${image.bytes})`;
      const bot = await this.put(sql, current ? editedBotRecord(current, value) : newBotRecord(owner, value));
      await sql`DELETE a FROM panda_force_bot_avatars a LEFT JOIN panda_force_bots b ON b.owner=a.owner AND JSON_UNQUOTE(JSON_EXTRACT(b.data,'$.avatar.type'))='image' AND JSON_UNQUOTE(JSON_EXTRACT(b.data,'$.avatar.id'))=a.id WHERE a.owner=${owner} AND b.id IS NULL`;
      return bot;
    });
    if (result.sessionId) this.sessions.add(result.sessionId);
    return result;
  }
  hasSession(id: string) {
    return this.sessions.has(id);
  }
  async prepareSession(owner: string, id: string) {
    return this.context.transaction(async (sql) => {
      const current = await this.readBot(sql, owner, id, true);
      if ((current.sessionTasks ?? 0) >= 100) {
        current.sessionTasks = 0;
        current.sessionId = null;
      }
      current.sessionTasks = (current.sessionTasks ?? 0) + 1;
      return this.put(sql, current);
    });
  }
  async setSession(owner: string, id: string, sessionId: string) {
    const result = await this.context.transaction(async (sql) => {
      const current = await this.readBot(sql, owner, id, true);
      current.sessionId = sessionId;
      return this.put(sql, current);
    });
    this.sessions.add(sessionId);
    return result;
  }
}
