import type { ConnectionInput } from "../../shared/connections/contracts.js";
import type { ConnectionConnector } from "./connector-port.js";
import { ConnectionError } from "./errors.js";

/** The composition root installs trusted connectors; requests cannot load modules or commands. */
export class ConnectionRegistry {
  private connectors = new Map<string, ConnectionConnector>();
  constructor(connectors: ConnectionConnector[]) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.id)) throw new Error("Duplicate publication connector");
      this.connectors.set(connector.id, connector);
    }
  }
  get(id: unknown) {
    const connector = typeof id === "string" ? this.connectors.get(id) : undefined;
    if (!connector) throw new ConnectionError("unsupportedConnector");
    return connector;
  }
  parse(value: unknown): ConnectionInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("invalidInput");
    return this.get((value as Record<string, unknown>).connector).parse(value);
  }
  roots() {
    return [...this.connectors.values()].flatMap((connector) => connector.roots());
  }
}
