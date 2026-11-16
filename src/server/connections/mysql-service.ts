import { ConnectionError } from "./errors.js";
import type { ConnectionPersistence } from "./persistence.js";
import type { ConnectionRegistry } from "./registry.js";
import { connectionId, connectionText, connectionUrl, connectionVersion } from "./validation.js";
export class MySQLConnectionService {
  constructor(
    private store: ConnectionPersistence["records"],
    private connectors: ConnectionRegistry,
    private requireProject: (id: string) => unknown,
    private transaction: ConnectionPersistence["transaction"],
  ) {}
  roots() {
    return this.connectors.roots();
  }
  async list(ownerId: string, projectId: string) {
    await this.requireProject(connectionId(projectId));
    return await this.store.list(ownerId, projectId);
  }
  async owned(ownerId: string, id: string) {
    const stored = await this.store.get(connectionId(id));
    if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
    await this.requireProject(stored.connection.projectId);
    if (this.connectors.get(stored.connection.connector).target(stored.connection) !== stored.targetPath)
      throw new ConnectionError("targetChanged", 409);
    return stored;
  }
  async create(ownerId: string, value: unknown) {
    const input = this.connectors.parse(value);
    await this.requireProject(input.projectId);
    const previous = await this.store.existing(ownerId, input);
    if (previous) return previous;
    const connector = this.connectors.get(input.connector),
      path = connector.target(input);
    await connector.inspect(ownerId, input);
    return this.transaction(async () => {
      await this.requireProject(input.projectId);
      if (input.connector === "local-site") await connector.inspect(ownerId, input);
      return this.store.create(ownerId, input, path);
    });
  }
  async assertReady(ownerId: string, id: string) {
    const { connection } = await this.owned(ownerId, id);
    this.connectors.get(connection.connector).ready(connection);
  }
  async update(ownerId: string, id: string, value: unknown) {
    await this.owned(ownerId, id);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["version", "enabled", "name", "publicUrl"].includes(key)) ||
      typeof input.enabled !== "boolean"
    )
      throw new ConnectionError("invalidInput");
    const enabled = input.enabled;
    return this.transaction(async () => {
      await this.owned(ownerId, id);
      return await this.store.update(ownerId, id, connectionVersion(input.version), {
        name: connectionText(input.name, 120),
        publicUrl: connectionUrl(input.publicUrl),
        enabled,
      });
    });
  }
  async test(ownerId: string, id: string, version: number) {
    const { connection } = await this.owned(ownerId, id);
    if (connection.version !== connectionVersion(version)) throw new ConnectionError("conflict", 409);
    const connector = this.connectors.get(connection.connector);
    const result =
      connection.connector === "local-site"
        ? await this.transaction(async () => {
            await this.owned(ownerId, id);
            return connector.test(ownerId, connection);
          })
        : await connector.test(ownerId, connection);
    return this.transaction(async () => {
      if ((await this.owned(ownerId, id)).connection.version !== version) throw new ConnectionError("conflict", 409);
      return { ...result, connection: await this.store.completeTest(ownerId, id, version) };
    });
  }
}
