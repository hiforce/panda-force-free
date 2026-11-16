import type { PublicationConnection } from "../../shared/connections/contracts.js";
import type { ConnectionService } from "./service.js";
import type { ConnectionRepository } from "./repository.js";
import type { ConnectionRegistry } from "./registry.js";
import type { CredentialEncryption, CredentialStore } from "./credentials/ports.js";
import { ConnectionError } from "./errors.js";
import { connectionVersion } from "./validation.js";

/** Encryption happens outside transactions; ciphertext and public version commit atomically. */
export class ConnectionSecretService {
  constructor(
    private connections: ConnectionService,
    private records: ConnectionRepository,
    private registry: ConnectionRegistry,
    private secrets: CredentialStore,
    private cipher: CredentialEncryption,
  ) {}
  async write(owner: string, id: string, value: unknown) {
    const { connection } = this.connections.owned(owner, id);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["version", "credential"].includes(key)))
      throw new ConnectionError("invalidInput");
    const version = connectionVersion(input.version);
    if (connection.version !== version) throw new ConnectionError("conflict", 409);
    const credential = this.registry.get(connection.connector).credential(input.credential);
    const binding = { ownerId: owner, connectorId: connection.connector, connectionId: id };
    const envelope = await this.cipher.seal(binding, credential);
    this.connections.owned(owner, id);
    return this.records.changeCredential(owner, id, version, () =>
      this.secrets.put(binding, connection.credentialRevision || 0, envelope),
    );
  }
  async read(owner: string, connection: PublicationConnection) {
    const current = this.connections.owned(owner, connection.id).connection;
    if (current.connector !== connection.connector) throw new ConnectionError("targetChanged", 409);
    const binding = { ownerId: owner, connectorId: current.connector, connectionId: current.id };
    const saved = this.secrets.get(binding);
    if (saved.metadata.revision !== current.credentialRevision) throw new ConnectionError("credentialConflict", 409);
    return this.cipher.open(binding, saved.envelope);
  }
}
