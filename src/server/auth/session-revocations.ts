import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Revocations live on the workspace owner's private volume and survive its restart. */
export function createSessionRevocations(path: string, now = Date.now) {
  let database: Database | null = null;
  const watchers = new Map<string, Set<() => void>>();
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  function open(create = false) {
    if (database) return database;
    if (!create && !existsSync(path)) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    database = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS revoked_sessions(digest TEXT PRIMARY KEY,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS revoked_sessions_expiry ON revoked_sessions(expires_at)",
    );
    return database;
  }
  function has(token: string) {
    const result = open()
      ?.query<{ expires_at: number }, [string]>("SELECT expires_at FROM revoked_sessions WHERE digest=?")
      .get(digest(token));
    return Boolean(result && result.expires_at > now());
  }
  return {
    has,
    revoke(token: string) {
      const expiresAt = Number(token.split(".")[0]);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return;
      const key = digest(token),
        db = open(true)!;
      db.transaction(() => {
        db.query("DELETE FROM revoked_sessions WHERE expires_at<=?").run(now());
        db.query(
          "INSERT INTO revoked_sessions VALUES(?,?) ON CONFLICT(digest) DO UPDATE SET expires_at=excluded.expires_at",
        ).run(key, expiresAt);
      }).immediate();
      const active = [...(watchers.get(key) || [])];
      watchers.delete(key);
      for (const close of active) {
        try {
          close();
        } catch {
          /* A closing socket must not prevent other sessions from closing. */
        }
      }
    },
    watch(token: string, close: () => void) {
      if (has(token)) {
        close();
        return () => {};
      }
      const key = digest(token),
        active = watchers.get(key) || new Set<() => void>();
      active.add(close);
      watchers.set(key, active);
      return () => {
        active.delete(close);
        if (!active.size) watchers.delete(key);
      };
    },
    close() {
      watchers.clear();
      database?.close();
      database = null;
    },
  };
}
