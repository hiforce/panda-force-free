import { decodeMember } from "./records.js";
import type { SQL } from "bun";
import {
  AccountError,
  LOCAL_MEMBER_CAPACITY,
  type LocalAccountSettings,
  type LocalUserRecord,
  type LocalUserRepository,
} from "./contracts.js";

export class MySQLLocalUsers implements LocalUserRepository {
  constructor(private readonly sql: SQL) {}
  async list() {
    return (await this.sql`SELECT record FROM panda_force_identity_users ORDER BY username`).map(
      (row: { record: string }) => decodeMember(row.record),
    );
  }
  async get(id: string) {
    const row = (await this.sql`SELECT record FROM panda_force_identity_users WHERE id=${id}`)[0];
    return row ? decodeMember(row.record) : null;
  }
  async find(username: string) {
    const row = (await this.sql`SELECT record FROM panda_force_identity_users WHERE username=${username}`)[0];
    return row ? decodeMember(row.record) : null;
  }
  async findChallenge(id: string) {
    const row = (
      await this
        .sql`SELECT record FROM panda_force_identity_users WHERE JSON_UNQUOTE(JSON_EXTRACT(record,'$.invitation.operationId'))=${id}`
    )[0];
    return row ? decodeMember(row.record) : null;
  }
  async create(record: LocalUserRecord) {
    await this.sql.begin(async (tx) => {
      // The immutable installation administrator serializes bounded catalog creation.
      await tx`SELECT id FROM panda_force_identity_credentials WHERE id='administrator' FOR UPDATE`;
      const count = (await tx`SELECT COUNT(*) n FROM panda_force_identity_users`)[0].n;
      if (Number(count) >= LOCAL_MEMBER_CAPACITY) throw new AccountError("limit", 409);
      try {
        await tx`INSERT INTO panda_force_identity_users(id,username,record,revision) VALUES(${record.id},${record.username},${JSON.stringify(record)},${record.revision})`;
      } catch (error) {
        if ((error as { errno?: number }).errno === 1062) throw new AccountError("conflict", 409);
        throw error;
      }
    });
  }
  async settings(): Promise<LocalAccountSettings> {
    const row = (await this.sql`SELECT record FROM panda_force_identity_settings WHERE id=1`)[0];
    return row ? JSON.parse(row.record) : { revision: 0 };
  }
  async saveSettings(record: LocalAccountSettings, revision: number) {
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO panda_force_identity_settings(id,record,revision) VALUES(1,'{"revision":0}',0) ON DUPLICATE KEY UPDATE id=id`;
      const current = (await tx`SELECT revision FROM panda_force_identity_settings WHERE id=1 FOR UPDATE`)[0];
      if (Number(current.revision) !== revision) throw new AccountError("conflict", 409);
      await tx`UPDATE panda_force_identity_settings SET record=${JSON.stringify(record)},revision=${record.revision} WHERE id=1`;
    });
  }
  async update(record: LocalUserRecord, revision: number) {
    const result = await this
      .sql`UPDATE panda_force_identity_users SET record=${JSON.stringify(record)},revision=${record.revision} WHERE id=${record.id} AND revision=${revision}`;
    if (result.affectedRows !== 1) throw new AccountError("conflict", 409);
  }
  close() {}
}
