import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BotError, botText } from "../../shared/bots/contracts.js";
import type { SQLiteBotProfiles } from "./sqlite-profiles.js";
type Row = { data: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class SQLiteBotKeys {
  constructor(
    private readonly db: Database,
    private readonly profiles: SQLiteBotProfiles,
  ) {}
  keys(owner: string): Array<Record<string, unknown>> {
    return this.db
      .query<Row, [string]>("SELECT data FROM bot_keys WHERE owner=? ORDER BY rowid DESC")
      .all(owner)
      .map((r) => JSON.parse(r.data));
  }
  issue(owner: string, value: Record<string, unknown>) {
    const ids = value.botIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string"))
      throw new BotError("invalidScope");
    const botIds = ids.map((id) => this.profiles.bot(owner, id as string).id);
    const days = Number(value.days ?? 90);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BotError("invalidExpiry");
    if (this.keys(owner).filter((k) => !k.revokedAt && Number(k.expiresAt) > Date.now()).length >= 100)
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
    this.db
      .query("INSERT INTO bot_keys VALUES(?,?,?,?)")
      .run(id, owner, digest("panda-bots-v1:" + secret), JSON.stringify(key));
    return { key, secret };
  }
  revoke(owner: string, id: string) {
    const key = this.keys(owner).find((k) => k.id === id);
    if (!key) throw new BotError("notFound", 404);
    key.revokedAt = Date.now();
    this.db.query("UPDATE bot_keys SET data=? WHERE id=? AND owner=?").run(JSON.stringify(key), id, owner);
  }
  authenticate(secret: string): { owner: string; botIds: string[] } {
    const match = /^pfb_([a-f0-9]{24})_[A-Za-z0-9_-]{43}$/.exec(secret);
    if (!match) throw new BotError("unauthorized", 401);
    const r = this.db
      .query<{ owner: string; digest: string; data: string }, [string]>("SELECT * FROM bot_keys WHERE id=?")
      .get(match[1]!);
    if (!r || !timingSafeEqual(Buffer.from(r.digest, "hex"), Buffer.from(digest("panda-bots-v1:" + secret), "hex")))
      throw new BotError("unauthorized", 401);
    const key = JSON.parse(r.data);
    if (key.revokedAt || key.expiresAt <= Date.now()) throw new BotError("unauthorized", 401);
    if (!key.lastUsedAt || key.lastUsedAt < Date.now() - 60000) {
      key.lastUsedAt = Date.now();
      this.db.query("UPDATE bot_keys SET data=? WHERE id=?").run(JSON.stringify(key), match[1]!);
    }
    return { owner: r.owner, botIds: key.botIds };
  }
}
