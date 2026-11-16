import type { Database } from "bun:sqlite";
import { BotError } from "../../shared/bots/contracts.js";

/** Avatar blobs stay private and outside the frequently returned Bot JSON records. */
export class BotAvatars {
  constructor(private db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS bot_avatars(owner TEXT NOT NULL, id TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(owner,id))",
    );
  }
  put(owner: string, id: string, bytes: Uint8Array) {
    this.db.query("INSERT INTO bot_avatars VALUES(?,?,?) ON CONFLICT(owner,id) DO NOTHING").run(owner, id, bytes);
  }
  read(owner: string, id: string): Uint8Array {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new BotError("notFound", 404);
    const row = this.db
      .query<{ bytes: Uint8Array }, [string, string]>("SELECT bytes FROM bot_avatars WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row) throw new BotError("notFound", 404);
    return row.bytes;
  }
  prune(owner: string) {
    this.db
      .query(
        "DELETE FROM bot_avatars WHERE owner=?1 AND id NOT IN (SELECT json_extract(data,'$.avatar.id') FROM bots WHERE owner=?1 AND json_extract(data,'$.avatar.type')='image' AND json_extract(data,'$.avatar.id') IS NOT NULL)",
      )
      .run(owner);
  }
}
