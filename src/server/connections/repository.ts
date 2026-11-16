import type { Database } from "bun:sqlite";
import type { PublicationConnection, ConnectionInput } from "../../shared/connections/contracts.js";
import { ConnectionError } from "./errors.js";

export interface OwnedConnection {
  ownerId: string;
  targetPath: string;
  connection: PublicationConnection;
}
/** Targets retain ownership when disabled, so another connection cannot silently take over a site. */
export class ConnectionRepository {
  constructor(private db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS publication_connection_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
    );
    db.transaction(() => {
      const version =
        db.query<{ version: number }, []>("SELECT version FROM publication_connection_schema WHERE id=1").get()
          ?.version || 0;
      if (version > 1) throw new ConnectionError("unavailable", 503);
      if (version) return;
      db.exec(`CREATE TABLE IF NOT EXISTS publication_connections (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, projectId TEXT NOT NULL,
      targetPath TEXT NOT NULL UNIQUE, record TEXT NOT NULL, request TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS connections_by_owner ON publication_connections(ownerId,projectId);
    INSERT INTO publication_connection_schema VALUES(1,1);`);
    }).immediate();
  }
  get(id: string): OwnedConnection {
    const row = this.db
      .query<{ ownerId: string; targetPath: string; record: string }, [string]>(
        "SELECT ownerId,targetPath,record FROM publication_connections WHERE id=?",
      )
      .get(id);
    if (!row) throw new ConnectionError("notFound", 404);
    return { ownerId: row.ownerId, targetPath: row.targetPath, connection: JSON.parse(row.record) };
  }
  list(ownerId: string, projectId: string): PublicationConnection[] {
    return this.db
      .query<{ record: string }, [string, string]>(
        "SELECT record FROM publication_connections WHERE ownerId=? AND projectId=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(ownerId, projectId)
      .map((row) => JSON.parse(row.record));
  }
  existing(ownerId: string, input: ConnectionInput): PublicationConnection | null {
    const row = this.db
      .query<{ ownerId: string; request: string; record: string }, [string]>(
        "SELECT ownerId,request,record FROM publication_connections WHERE id=?",
      )
      .get(input.id);
    if (!row) return null;
    if (row.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
    if (row.request !== JSON.stringify(input)) throw new ConnectionError("conflict", 409);
    return JSON.parse(row.record);
  }
  create(ownerId: string, input: ConnectionInput, targetPath: string) {
    return this.db
      .transaction(() => {
        const existing = this.existing(ownerId, input);
        if (existing) return existing;
        const targets = this.db
          .query<{ targetPath: string }, []>("SELECT targetPath FROM publication_connections")
          .all();
        if (targets.length >= 1000 || this.list(ownerId, input.projectId).length >= 100)
          throw new ConnectionError("limit", 507);
        if (
          targets.some(
            (row) =>
              row.targetPath === targetPath ||
              row.targetPath.startsWith(targetPath + "/") ||
              targetPath.startsWith(row.targetPath + "/"),
          )
        )
          throw new ConnectionError("targetInUse", 409);
        const now = Date.now(),
          connection: PublicationConnection = { ...input, version: 1, enabled: true, createdAt: now, updatedAt: now };
        this.db
          .query("INSERT INTO publication_connections VALUES(?,?,?,?,?,?)")
          .run(input.id, ownerId, input.projectId, targetPath, JSON.stringify(connection), JSON.stringify(input));
        return connection;
      })
      .immediate();
  }
  update(
    ownerId: string,
    id: string,
    version: number,
    changes: Pick<PublicationConnection, "name" | "enabled" | "publicUrl">,
  ) {
    return this.db
      .transaction(() => {
        const stored = this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        if (stored.connection.version !== version) throw new ConnectionError("conflict", 409);
        const connection = { ...stored.connection, ...changes, version: version + 1, updatedAt: Date.now() };
        this.db.query("UPDATE publication_connections SET record=? WHERE id=?").run(JSON.stringify(connection), id);
        return connection;
      })
      .immediate();
  }
  changeCredential(ownerId: string, id: string, version: number, persist: () => { revision: number }) {
    return this.db
      .transaction(() => {
        const stored = this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        if (stored.connection.version !== version) throw new ConnectionError("conflict", 409);
        const credential = persist();
        const connection = {
          ...stored.connection,
          credentialRevision: credential.revision,
          version: version + 1,
          updatedAt: Date.now(),
        };
        this.db.query("UPDATE publication_connections SET record=? WHERE id=?").run(JSON.stringify(connection), id);
        return connection;
      })
      .immediate();
  }
  replaceHostKey(ownerId: string, id: string, version: number, hostKey: string) {
    return this.db
      .transaction(() => {
        const stored = this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        const current = stored.connection;
        if (current.version !== version) throw new ConnectionError("conflict", 409);
        if (current.connector !== "sftp-site") throw new ConnectionError("unsupportedConnector");
        if (current.hostKey === hostKey) return current;
        const connection = { ...current, hostKey, trustPending: true, version: version + 1, updatedAt: Date.now() };
        this.db.query("UPDATE publication_connections SET record=? WHERE id=?").run(JSON.stringify(connection), id);
        return connection;
      })
      .immediate();
  }
  completeTest(ownerId: string, id: string, version: number) {
    return this.db
      .transaction(() => {
        const stored = this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        if (stored.connection.version !== version) throw new ConnectionError("conflict", 409);
        if (!stored.connection.trustPending) return stored.connection;
        // Verification updates readiness only; the trusted configuration version stays unchanged.
        const connection = { ...stored.connection, trustPending: false };
        this.db.query("UPDATE publication_connections SET record=? WHERE id=?").run(JSON.stringify(connection), id);
        return connection;
      })
      .immediate();
  }
}
