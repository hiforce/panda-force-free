import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
/** Native relational admission retains the local cache owner without creating or consulting SQLite provider ledgers. */
export function openEmbeddingCacheDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw Error("Unsupported embedding cache version");
      if (!version)
        db.exec(`
    CREATE TABLE embedding_cache(key TEXT PRIMARY KEY,namespace TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,
     dimensions INTEGER NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,accessedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE INDEX embedding_cache_expiry ON embedding_cache(expiresAt,state);
    CREATE INDEX embedding_cache_lru ON embedding_cache(state,accessedAt,key);
    CREATE TABLE embedding_cache_totals(id INTEGER PRIMARY KEY CHECK(id=1),entries INTEGER NOT NULL CHECK(entries>=0),bytes INTEGER NOT NULL CHECK(bytes>=0));
    INSERT INTO embedding_cache_totals VALUES(1,0,0);
    CREATE TRIGGER embedding_cache_insert AFTER INSERT ON embedding_cache BEGIN UPDATE embedding_cache_totals SET entries=entries+1,bytes=bytes+new.bytes WHERE id=1; END;
    CREATE TRIGGER embedding_cache_delete AFTER DELETE ON embedding_cache BEGIN UPDATE embedding_cache_totals SET entries=entries-1,bytes=bytes-old.bytes WHERE id=1; END;
    PRAGMA user_version=1;
   `);
      db.exec(
        "UPDATE embedding_cache_totals SET entries=(SELECT count(*) FROM embedding_cache),bytes=(SELECT coalesce(sum(bytes),0) FROM embedding_cache) WHERE id=1",
      );
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
