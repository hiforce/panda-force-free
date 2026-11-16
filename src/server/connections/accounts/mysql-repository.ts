import type { SocialAccount } from "../../../shared/connections/accounts.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import type { SecretEnvelope } from "../credentials/ports.js";
import { ConnectionError } from "../errors.js";
import type { OAuthTokens } from "../oauth/ports.js";
import type { AccountTokenTarget } from "./token-port.js";
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
export class MySQLSocialAccountRepository {
  constructor(private db: MySQLSession) {}
  async encryptedCount() {
    return await this.db.atomic(async () => {
      return (await this.db.one<{
        total: number;
      }>("SELECT count(*) AS total FROM panda_force_publication_accounts", []))!.total;
    });
  }
  async get(owner: string, id: string): Promise<StoredSocialAccount> {
    return await this.db.atomic(async () => {
      const row = await this.db.one<Row>("SELECT * FROM panda_force_publication_accounts WHERE id=? AND ownerId=?", [
        id,
        owner,
      ]);
      if (!row) throw new ConnectionError("notFound", 404);
      return {
        ownerId: row.ownerId,
        configurationId: row.configurationId,
        configuration: row.configuration,
        secret: JSON.parse(row.secret),
        connection: JSON.parse(row.record),
        credentialRevision: row.credentialRevision,
      };
    });
  }
  async list(owner: string, project: string): Promise<SocialAccount[]> {
    return await this.db.atomic(async () => {
      return (
        await this.db.all<{
          record: string;
        }>(
          "SELECT record FROM panda_force_publication_accounts WHERE ownerId=? AND projectId=? ORDER BY rowSequence DESC LIMIT 100",
          [owner, project],
        )
      ).map((row) => JSON.parse(row.record));
    });
  }
  async create(value: StoredSocialAccount): Promise<SocialAccount> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const exists = await this.db.one<{
          id: string;
        }>("SELECT id FROM panda_force_publication_accounts WHERE id=?", [value.connection.id]);
        if (exists) {
          const previous = await this.get(value.ownerId, exists.id);
          if (
            previous.configuration !== value.configuration ||
            previous.connection.projectId !== value.connection.projectId ||
            previous.connection.name !== value.connection.name
          )
            throw new ConnectionError("conflict", 409);
          return previous.connection;
        }
        if (
          (await this.encryptedCount()) >= 1000 ||
          (await this.list(value.ownerId, value.connection.projectId)).length >= 100
        )
          throw new ConnectionError("limit", 507);
        await this.db.execute(
          "INSERT INTO panda_force_publication_accounts(id,ownerId,projectId,configurationId,configuration,secret,record,credentialRevision) VALUES(?,?,?,?,?,?,?,?)",
          [
            value.connection.id,
            value.ownerId,
            value.connection.projectId,
            value.configurationId,
            value.configuration,
            JSON.stringify(value.secret),
            JSON.stringify(value.connection),
            value.credentialRevision,
          ],
        );
        return value.connection;
      });
    });
  }
  async rotate(
    target: AccountTokenTarget,
    grant: Pick<OAuthTokens, "expiresAt" | "scopes">,
    persist: () =>
      | {
          revision: number;
        }
      | Promise<
          Awaited<{
            revision: number;
          }>
        >,
  ) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const current = await this.get(target.ownerId, target.connectionId),
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
        const metadata = await persist();
        const changed =
          JSON.stringify([...connection.grant.scopes].sort()) !== JSON.stringify([...grant.scopes].sort());
        const next = {
          ...connection,
          version: connection.version + Number(changed),
          updatedAt: Date.now(),
          grant: { ...grant, credentialRevision: metadata.revision },
        };
        await this.db.execute("UPDATE panda_force_publication_accounts SET record=?,credentialRevision=? WHERE id=?", [
          JSON.stringify(next),
          metadata.revision,
          target.connectionId,
        ]);
      });
    });
  }
  /** Awaited metadata mutations share the credential and consent transaction; platform IO stays in services. */
  async change(
    owner: string,
    id: string,
    version: number,
    mutate: (
      current: StoredSocialAccount,
    ) =>
      | (StoredSocialAccount | Promise<StoredSocialAccount>)
      | Promise<Awaited<StoredSocialAccount | Promise<StoredSocialAccount>>>,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const current = await this.get(owner, id);
        if (current.connection.version !== version) throw new ConnectionError("conflict", 409);
        const next = await mutate(current);
        if (
          next.ownerId !== owner ||
          next.connection.id !== id ||
          next.connection.projectId !== current.connection.projectId ||
          next.connection.provider !== current.connection.provider ||
          (current.connection.account && next.connection.account?.id !== current.connection.account.id)
        )
          throw new ConnectionError("targetChanged", 409);
        next.connection = { ...next.connection, version: version + 1, updatedAt: Date.now() };
        await this.db.execute(
          "UPDATE panda_force_publication_accounts SET configurationId=?,configuration=?,secret=?,record=?,credentialRevision=? WHERE id=?",
          [
            next.configurationId,
            next.configuration,
            JSON.stringify(next.secret),
            JSON.stringify(next.connection),
            next.credentialRevision,
            id,
          ],
        );
        return next.connection;
      });
    });
  }
}
