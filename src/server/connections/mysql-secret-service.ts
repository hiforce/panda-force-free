import type { PublicationConnection } from "../../shared/connections/contracts.js";
import type { AsyncPublicationStore } from "./async-ports.js";
import type { CredentialEncryption, CredentialStore } from "./credentials/ports.js";
import { ConnectionError } from "./errors.js";
import type { MySQLConnectionService } from "./mysql-service.js";
import type { ConnectionPersistence } from "./persistence.js";
import type { ConnectionRegistry } from "./registry.js";
import { connectionVersion } from "./validation.js";
/** Encryption happens outside transactions; ciphertext and public version commit atomically. */
export class MySQLConnectionSecretService {
  constructor(
    private connections: MySQLConnectionService,
    private records: ConnectionPersistence["records"],
    private registry: ConnectionRegistry,
    private secrets: AsyncPublicationStore<CredentialStore>,
    private cipher: CredentialEncryption,
  ) {}
  async write(owner: string, id: string, value: unknown) {
    const { connection } = await this.connections.owned(owner, id);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["version", "credential"].includes(key)))
      throw new ConnectionError("invalidInput");
    const version = connectionVersion(input.version);
    if (connection.version !== version) throw new ConnectionError("conflict", 409);
    const credential = this.registry.get(connection.connector).credential(input.credential);
    const binding = { ownerId: owner, connectorId: connection.connector, connectionId: id };
    const envelope = await this.cipher.seal(binding, credential);
    return await this.records.changeCredential(owner, id, version, async () => {
      await this.connections.owned(owner, id);
      return this.secrets.put(binding, connection.credentialRevision || 0, envelope);
    });
  }
  async read(owner: string, connection: PublicationConnection) {
    const current = (await this.connections.owned(owner, connection.id)).connection;
    if (current.connector !== connection.connector) throw new ConnectionError("targetChanged", 409);
    const binding = { ownerId: owner, connectorId: current.connector, connectionId: current.id };
    const saved = await this.secrets.get(binding);
    if (saved.metadata.revision !== current.credentialRevision) throw new ConnectionError("credentialConflict", 409);
    const plain = await this.cipher.open(binding, saved.envelope);
    const after = (await this.connections.owned(owner, connection.id)).connection;
    if (after.version !== current.version || after.credentialRevision !== saved.metadata.revision)
      throw new ConnectionError("credentialConflict", 409);
    return plain;
  }
}
