import type { SQL } from "bun";
import { isStoredAdministrator, type StoredAdministrator } from "./administrator-store.js";
import type { StoredPassword } from "./password-store.js";
import { isStoredPassword } from "./security.js";
export class MySQLIdentityCredentials {
  constructor(private readonly sql: SQL) {}
  private async load(id: string): Promise<unknown> {
    const r = (await this.sql`SELECT data FROM panda_force_identity_credentials WHERE id=${id}`)[0];
    return r ? JSON.parse(r.data) : null;
  }
  async administrator(): Promise<StoredAdministrator | null> {
    const value = await this.load("administrator");
    if (value !== null && !isStoredAdministrator(value)) throw Error("authStorageUnavailable");
    return value;
  }
  async password(): Promise<StoredPassword | null> {
    const value = await this.load("managed-password");
    if (value !== null && !isStoredPassword(value)) throw Error("authStorageUnavailable");
    return value as StoredPassword | null;
  }
  async saveAdministrator(value: StoredAdministrator) {
    if (!isStoredAdministrator(value)) throw Error("authStorageUnavailable");
    try {
      await this
        .sql`INSERT INTO panda_force_identity_credentials(id,data) VALUES('administrator',${JSON.stringify(value)})`;
    } catch (error) {
      if ((error as { errno?: number }).errno === 1062) {
        const duplicate = Object.assign(Error("Administrator already exists"), { code: "EEXIST" });
        throw duplicate;
      }
      throw Error("authStorageUnavailable", { cause: error });
    }
  }
}
