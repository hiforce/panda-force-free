import { decodeMember } from "./records.js";
import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccountError,
  LOCAL_MEMBER_CAPACITY,
  type LocalAccountSettings,
  type LocalUserRecord,
  type LocalUserRepository,
} from "./contracts.js";

/** Login reads are indexed; account mutations retain uniqueness and a bounded installation catalog. */
export class SQLiteLocalUsers implements LocalUserRepository {
  private readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL,revision INTEGER NOT NULL)",
    );
  }
  list() {
    return this.db
      .query<{ record: string }, []>("SELECT record FROM users ORDER BY username")
      .all()
      .map((row) => decodeMember(row.record));
  }
  get(id: string) {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM users WHERE id=?").get(id);
    return row ? decodeMember(row.record) : null;
  }
  find(username: string) {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM users WHERE username=?").get(username);
    return row ? decodeMember(row.record) : null;
  }
  findChallenge(id: string) {
    const row = this.db
      .query<{ record: string }, [string]>(
        "SELECT record FROM users WHERE json_extract(record,'$.invitation.operationId')=?",
      )
      .get(id);
    return row ? decodeMember(row.record) : null;
  }
  create(record: LocalUserRecord) {
    this.db
      .transaction(() => {
        if (this.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM users").get()!.n >= LOCAL_MEMBER_CAPACITY)
          throw new AccountError("limit", 409);
        if (this.find(record.username)) throw new AccountError("conflict", 409);
        this.db.query("INSERT INTO users VALUES(?,?,?)").run(record.id, record.username, JSON.stringify(record));
      })
      .immediate();
  }
  settings(): LocalAccountSettings {
    const row = this.db.query<{ record: string }, []>("SELECT record FROM settings WHERE id=1").get();
    return row ? JSON.parse(row.record) : { revision: 0 };
  }
  saveSettings(record: LocalAccountSettings, revision: number) {
    this.db
      .transaction(() => {
        if (this.settings().revision !== revision) throw new AccountError("conflict", 409);
        this.db
          .query(
            "INSERT INTO settings(id,record,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,revision=excluded.revision",
          )
          .run(JSON.stringify(record), record.revision);
      })
      .immediate();
  }
  update(record: LocalUserRecord, revision: number) {
    this.db
      .transaction(() => {
        const previous = this.get(record.id);
        if (!previous || previous.revision !== revision) throw new AccountError("conflict", 409);
        this.db.query("UPDATE users SET record=? WHERE id=?").run(JSON.stringify(record), record.id);
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
