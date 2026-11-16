import type { Database } from "bun:sqlite";
import type { SocialAccount } from "../../../shared/connections/accounts.js";
import type { AccountTokenTarget } from "./token-port.js";
import type { OAuthTokens } from "../oauth/ports.js";
import type { SecretEnvelope } from "../credentials/ports.js";
import { ConnectionError } from "../errors.js";

export interface StoredSocialAccount {
  ownerId: string;
  configurationId: string;
  configuration: string;
  secret: SecretEnvelope;
  connection: SocialAccount;
  credentialRevision: number;
}
interface Row {
  ownerId: string;
  configurationId: string;
  configuration: string;
  secret: string;
  record: string;
  credentialRevision: number;
}

/** Account identity and project scope never inherit the exclusive directory semantics of site connections. */
export class SocialAccountRepository {
  constructor(private db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS publication_account_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
    );
    db.transaction(() => {
      const version =
        db.query<{ version: number }, []>("SELECT version FROM publication_account_schema WHERE id=1").get()?.version ||
        0;
      if (version > 1) throw new ConnectionError("unavailable", 503);
      if (!version)
        db.exec(`CREATE TABLE publication_accounts (
        id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,projectId TEXT NOT NULL,configurationId TEXT NOT NULL,
        configuration TEXT NOT NULL,secret TEXT NOT NULL,record TEXT NOT NULL,credentialRevision INTEGER NOT NULL DEFAULT 0
      ); CREATE INDEX publication_accounts_owner ON publication_accounts(ownerId,projectId);
      INSERT INTO publication_account_schema VALUES(1,1);`);
    }).immediate();
  }
  encryptedCount() {
    return this.db.query<{ total: number }, []>("SELECT count(*) AS total FROM publication_accounts").get()!.total;
  }
  get(owner: string, id: string): StoredSocialAccount {
    const row = this.db
      .query<Row, [string, string]>("SELECT * FROM publication_accounts WHERE id=? AND ownerId=?")
      .get(id, owner);
    if (!row) throw new ConnectionError("notFound", 404);
    return {
      ownerId: row.ownerId,
      configurationId: row.configurationId,
      configuration: row.configuration,
      secret: JSON.parse(row.secret),
      connection: JSON.parse(row.record),
      credentialRevision: row.credentialRevision,
    };
  }
  list(owner: string, project: string): SocialAccount[] {
    return this.db
      .query<{ record: string }, [string, string]>(
        "SELECT record FROM publication_accounts WHERE ownerId=? AND projectId=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(owner, project)
      .map((row) => JSON.parse(row.record));
  }
  create(value: StoredSocialAccount): SocialAccount {
    return this.db
      .transaction(() => {
        const exists = this.db
          .query<{ id: string }, [string]>("SELECT id FROM publication_accounts WHERE id=?")
          .get(value.connection.id);
        if (exists) {
          const previous = this.get(value.ownerId, exists.id);
          if (
            previous.configuration !== value.configuration ||
            previous.connection.projectId !== value.connection.projectId ||
            previous.connection.name !== value.connection.name
          )
            throw new ConnectionError("conflict", 409);
          return previous.connection;
        }
        if (this.encryptedCount() >= 1000 || this.list(value.ownerId, value.connection.projectId).length >= 100)
          throw new ConnectionError("limit", 507);
        this.db
          .query("INSERT INTO publication_accounts VALUES(?,?,?,?,?,?,?,?)")
          .run(
            value.connection.id,
            value.ownerId,
            value.connection.projectId,
            value.configurationId,
            value.configuration,
            JSON.stringify(value.secret),
            JSON.stringify(value.connection),
            value.credentialRevision,
          );
        return value.connection;
      })
      .immediate();
  }
  rotate(
    target: AccountTokenTarget,
    grant: Pick<OAuthTokens, "expiresAt" | "scopes">,
    persist: () => { revision: number },
  ) {
    this.db
      .transaction(() => {
        const current = this.get(target.ownerId, target.connectionId),
          connection = current.connection;
        if (
          !connection.enabled ||
          !connection.grant ||
          connection.version !== target.connectionVersion ||
          current.configuration !== target.configuration ||
          current.credentialRevision !== target.credentialRevision ||
          connection.account?.id !== target.accountId
        )
          throw new ConnectionError("conflict", 409);
        const metadata = persist();
        const changed =
          JSON.stringify([...connection.grant.scopes].sort()) !== JSON.stringify([...grant.scopes].sort());
        const next = {
          ...connection,
          version: connection.version + Number(changed),
          updatedAt: Date.now(),
          grant: { ...grant, credentialRevision: metadata.revision },
        };
        this.db
          .query("UPDATE publication_accounts SET record=?,credentialRevision=? WHERE id=?")
          .run(JSON.stringify(next), metadata.revision, target.connectionId);
      })
      .immediate();
  }
  /** Synchronous mutations share the credential and consent transaction; asynchronous work stays in services. */
  change(owner: string, id: string, version: number, mutate: (current: StoredSocialAccount) => StoredSocialAccount) {
    return this.db
      .transaction(() => {
        const current = this.get(owner, id);
        if (current.connection.version !== version) throw new ConnectionError("conflict", 409);
        const next = mutate(current);
        if (
          next.ownerId !== owner ||
          next.connection.id !== id ||
          next.connection.projectId !== current.connection.projectId ||
          next.connection.provider !== current.connection.provider ||
          (current.connection.account && next.connection.account?.id !== current.connection.account.id)
        )
          throw new ConnectionError("targetChanged", 409);
        next.connection = { ...next.connection, version: version + 1, updatedAt: Date.now() };
        this.db
          .query(
            "UPDATE publication_accounts SET configurationId=?,configuration=?,secret=?,record=?,credentialRevision=? WHERE id=?",
          )
          .run(
            next.configurationId,
            next.configuration,
            JSON.stringify(next.secret),
            JSON.stringify(next.connection),
            next.credentialRevision,
            id,
          );
        return next.connection;
      })
      .immediate();
  }
}
