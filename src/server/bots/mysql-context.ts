import { SQL } from "bun";
import { createHash } from "node:crypto";
import { BotError } from "../../shared/bots/contracts.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Shared transaction retry and lock policy; facets never open another pool or commit independently. */
export class MySQLBotContext {
  constructor(readonly pool: SQL) {}
  async operation<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BotError) throw error;
      const unavailable = new BotError("unavailable", 503);
      unavailable.cause = error;
      throw unavailable;
    }
  }
  async transaction<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
    return this.operation(async () => {
      for (let attempt = 0; ; attempt++)
        try {
          return (await this.pool.begin(work)) as T;
        } catch (error) {
          const errno = error && typeof error === "object" && "errno" in error ? Number(error.errno) : 0;
          if (attempt >= 2 || ![1213, 1205].includes(errno)) throw error;
          await Bun.sleep(20 * (attempt + 1));
        }
    });
  }
  async lock(sql: SQL, name: string) {
    name = name === "queue" ? name : "owner:" + digest(name);
    await sql`INSERT INTO panda_force_bot_control(name,value) VALUES(${name},'{}') ON DUPLICATE KEY UPDATE name=VALUES(name)`;
    await sql`SELECT name FROM panda_force_bot_control WHERE name=${name} FOR UPDATE`;
  }
}

export const duplicateBotRecord = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  (("errno" in error && error.errno === 1062) ||
    ("code" in error && ["ER_DUP_ENTRY", "ERR_MYSQL_DUPLICATE_ENTRY"].includes(String(error.code))));
