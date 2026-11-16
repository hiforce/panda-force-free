import type { ConnectionRepository } from "./repository.js";
import type { ConnectionRegistry } from "./registry.js";
import { ConnectionError } from "./errors.js";
import { connectionId, connectionText, connectionVersion, connectionUrl } from "./validation.js";

export class ConnectionService {
  constructor(
    private store: ConnectionRepository,
    private connectors: ConnectionRegistry,
    private requireProject: (id: string) => unknown,
  ) {}
  roots() {
    return this.connectors.roots();
  }
  list(ownerId: string, projectId: string) {
    this.requireProject(connectionId(projectId));
    return this.store.list(ownerId, projectId);
  }
  owned(ownerId: string, id: string) {
    const stored = this.store.get(connectionId(id));
    if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
    this.requireProject(stored.connection.projectId);
    if (this.connectors.get(stored.connection.connector).target(stored.connection) !== stored.targetPath)
      throw new ConnectionError("targetChanged", 409);
    return stored;
  }
  async create(ownerId: string, value: unknown) {
    const input = this.connectors.parse(value);
    this.requireProject(input.projectId);
    const previous = this.store.existing(ownerId, input);
    if (previous) return previous;
    const connector = this.connectors.get(input.connector),
      path = connector.target(input);
    await connector.inspect(ownerId, input);
    this.requireProject(input.projectId);
    return this.store.create(ownerId, input, path);
  }
  assertReady(ownerId: string, id: string) {
    const { connection } = this.owned(ownerId, id);
    this.connectors.get(connection.connector).ready(connection);
  }
  update(ownerId: string, id: string, value: unknown) {
    this.owned(ownerId, id);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["version", "enabled", "name", "publicUrl"].includes(key)) ||
      typeof input.enabled !== "boolean"
    )
      throw new ConnectionError("invalidInput");
    return this.store.update(ownerId, id, connectionVersion(input.version), {
      name: connectionText(input.name, 120),
      publicUrl: connectionUrl(input.publicUrl),
      enabled: input.enabled,
    });
  }
  async test(ownerId: string, id: string, version: number) {
    const { connection } = this.owned(ownerId, id);
    if (connection.version !== connectionVersion(version)) throw new ConnectionError("conflict", 409);
    const result = await this.connectors.get(connection.connector).test(ownerId, connection);
    if (this.owned(ownerId, id).connection.version !== version) throw new ConnectionError("conflict", 409);
    return { ...result, connection: this.store.completeTest(ownerId, id, version) };
  }
}
