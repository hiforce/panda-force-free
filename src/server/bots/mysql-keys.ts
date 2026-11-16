import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BotError, botText } from "../../shared/bots/contracts.js";
import { MySQLBotContext } from "./mysql-context.js";
import type { MySQLBotProfiles } from "./mysql-profiles.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class MySQLBotKeys {
  constructor(
    private readonly context: MySQLBotContext,
    private readonly profiles: MySQLBotProfiles,
  ) {}
  keys(owner: string): Promise<Array<Record<string, unknown>>> {
    return this.context.operation(async () =>
      (
        await this.context
          .pool`SELECT data FROM panda_force_bot_keys WHERE owner=${owner} ORDER BY JSON_EXTRACT(data,'$.createdAt') DESC,id`
      ).map((r: { data: string }) => JSON.parse(r.data)),
    );
  }
  issue(owner: string, value: Record<string, unknown>) {
    return this.context.transaction(async (sql) => {
      await this.context.lock(sql, "owner:" + owner);
      const ids = value.botIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string"))
        throw new BotError("invalidScope");
      const botIds: string[] = [];
      for (const id of ids) botIds.push((await this.profiles.readBot(sql, owner, id)).id);
      const days = Number(value.days ?? 90);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new BotError("invalidExpiry");
      const records = (await sql`SELECT data FROM panda_force_bot_keys WHERE owner=${owner}`).map(
        (r: { data: string }) => JSON.parse(r.data),
      );
      if (
        records.filter((k: { revokedAt: number; expiresAt: number }) => !k.revokedAt && k.expiresAt > Date.now())
          .length >= 100
      )
        throw new BotError("limit", 429);
      const id = randomBytes(12).toString("hex"),
        secret = `pfb_${id}_${randomBytes(32).toString("base64url")}`;
      const key = {
        id,
        owner,
        name: botText(value.name, 120),
        botIds,
        createdAt: Date.now(),
        expiresAt: Date.now() + days * 86400000,
        revokedAt: null,
        lastUsedAt: null,
      };
      await sql`INSERT INTO panda_force_bot_keys(id,owner,digest,data) VALUES(${id},${owner},${digest("panda-bots-v1:" + secret)},${JSON.stringify(key)})`;
      return { key, secret };
    });
  }
  revoke(owner: string, id: string) {
    return this.context.transaction(async (sql) => {
      const rows = await sql`SELECT data FROM panda_force_bot_keys WHERE owner=${owner} AND id=${id} FOR UPDATE`;
      if (!rows.length) throw new BotError("notFound", 404);
      await sql`UPDATE panda_force_bot_keys SET data=JSON_SET(data,'$.revokedAt',${Date.now()}) WHERE id=${id} AND owner=${owner}`;
    });
  }
  authenticate(secret: string) {
    return this.context.operation(async () => {
      const match = /^pfb_([a-f0-9]{24})_[A-Za-z0-9_-]{43}$/.exec(secret);
      if (!match) throw new BotError("unauthorized", 401);
      const rows = await this.context.pool`SELECT owner,digest,data FROM panda_force_bot_keys WHERE id=${match[1]!}`;
      const row = rows[0];
      if (
        !row ||
        !/^[a-f0-9]{64}$/.test(row.digest) ||
        !timingSafeEqual(Buffer.from(row.digest, "hex"), Buffer.from(digest("panda-bots-v1:" + secret), "hex"))
      )
        throw new BotError("unauthorized", 401);
      const key = JSON.parse(row.data),
        now = Date.now();
      if (key.revokedAt || key.expiresAt <= now) throw new BotError("unauthorized", 401);
      if (!key.lastUsedAt || key.lastUsedAt < now - 60000)
        await this.context
          .pool`UPDATE panda_force_bot_keys SET data=JSON_SET(data,'$.lastUsedAt',${now}) WHERE id=${match[1]!} AND (JSON_EXTRACT(data,'$.lastUsedAt') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(data,'$.lastUsedAt'))='null' OR JSON_EXTRACT(data,'$.lastUsedAt')<${now - 60000})`;
      return { owner: row.owner as string, botIds: key.botIds as string[] };
    });
  }
}
