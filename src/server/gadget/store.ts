import { storedLayout } from "./snapshot.js";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GadgetError, type GadgetLayout } from "../../shared/gadget/contracts.js";
import { emptyGadgetLayout } from "./snapshot.js";

/** User navigation is private presentation state, independent of package and execution authority. */
export class GadgetStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;PRAGMA synchronous=FULL;");
      this.db
        .transaction(() => {
          const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
          if (version > 1) throw new GadgetError("unavailable");
          if (!version)
            this.db
              .exec(`CREATE TABLE gadget_workspaces(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);
          CREATE TABLE gadget_workspace_operations(owner TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(owner,id));PRAGMA user_version=1;`);
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  read(owner: string): GadgetLayout {
    const row = this.db
      .query<{ revision: number; data: string }, [string]>("SELECT revision,data FROM gadget_workspaces WHERE owner=?")
      .get(owner);
    if (!row) return emptyGadgetLayout();
    try {
      const value = storedLayout(row.data);
      if (value.revision !== row.revision) throw Error();
      return value;
    } catch {
      throw new GadgetError("unavailable");
    }
  }
  replay(owner: string, id: string, request: string): GadgetLayout | null {
    const row = this.db
      .query<{ request: string; receipt: string }, [string, string]>(
        "SELECT request,receipt FROM gadget_workspace_operations WHERE owner=? AND id=?",
      )
      .get(owner, id);
    if (!row) return null;
    if (row.request !== request) throw new GadgetError("conflict");
    try {
      return storedLayout(row.receipt);
    } catch {
      throw new GadgetError("unavailable");
    }
  }
  save(owner: string, id: string, request: string, expected: number, next: GadgetLayout) {
    return this.db
      .transaction(() => {
        const replay = this.replay(owner, id, request);
        if (replay) return replay;
        if (this.read(owner).revision !== expected) throw new GadgetError("conflict");
        const value = { ...next, revision: expected + 1 },
          json = JSON.stringify(value);
        this.db
          .query(
            "INSERT INTO gadget_workspaces(owner,revision,data) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,data=excluded.data",
          )
          .run(owner, value.revision, json);
        this.db
          .query("INSERT INTO gadget_workspace_operations VALUES(?,?,?,?,?)")
          .run(owner, id, request, json, Date.now());
        this.db
          .query(
            "DELETE FROM gadget_workspace_operations WHERE owner=? AND rowid NOT IN(SELECT rowid FROM gadget_workspace_operations WHERE owner=? ORDER BY rowid DESC LIMIT 200)",
          )
          .run(owner, owner);
        return value;
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
