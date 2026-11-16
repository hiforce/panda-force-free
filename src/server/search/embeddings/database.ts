import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** This ledger contains cache digests, leases and usage counters, never source text, queries or vectors. */
export function openEmbeddingDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw Error("Unsupported embedding ledger version");
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
        CREATE TABLE embedding_locks(namespace TEXT PRIMARY KEY,token TEXT NOT NULL,untilAt INTEGER NOT NULL);
        CREATE TABLE embedding_inflight(token TEXT PRIMARY KEY,model TEXT NOT NULL,startedAt INTEGER NOT NULL,untilAt INTEGER NOT NULL);
        CREATE TABLE embedding_usage(bucket TEXT NOT NULL,window INTEGER NOT NULL,calls INTEGER NOT NULL,characters INTEGER NOT NULL,PRIMARY KEY(bucket,window));
        CREATE TABLE embedding_backoff(model TEXT PRIMARY KEY,attempts INTEGER NOT NULL,untilAt INTEGER NOT NULL);
        PRAGMA user_version=1;
      `);
    }).immediate();
    db.exec(
      "UPDATE embedding_cache_totals SET entries=(SELECT count(*) FROM embedding_cache),bytes=(SELECT coalesce(sum(bytes),0) FROM embedding_cache) WHERE id=1;",
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
