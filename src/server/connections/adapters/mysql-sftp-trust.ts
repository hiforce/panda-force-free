import { ConnectionError } from "../errors.js";
import type { MySQLConnectionService } from "../mysql-service.js";
import type { ConnectionPersistence } from "../persistence.js";
import { connectionVersion } from "../validation.js";
import { sftpHostKey } from "./sftp-input.js";
/** Trust changes are explicit, versioned configuration changes, never automatic host discovery. */
export class MySQLSftpHostTrust {
  constructor(
    private connections: MySQLConnectionService,
    private records: ConnectionPersistence["records"],
    private transaction: ConnectionPersistence["transaction"],
  ) {}
  async replace(owner: string, id: string, value: unknown) {
    const { connection } = await this.connections.owned(owner, id);
    if (connection.connector !== "sftp-site") throw new ConnectionError("unsupportedConnector");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["version", "hostKey"].includes(key)))
      throw new ConnectionError("invalidInput");
    return this.transaction(async () => {
      await this.connections.owned(owner, id);
      return this.records.replaceHostKey(owner, id, connectionVersion(input.version), sftpHostKey(input.hostKey));
    });
  }
}
