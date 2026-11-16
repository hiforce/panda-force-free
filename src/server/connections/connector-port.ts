import type {
  ConnectionInput,
  ConnectionTest,
  PublicationConnection,
  PublicationRoot,
} from "../../shared/connections/contracts.js";

/** Connector policies validate targets and capabilities, never execute publication jobs. */
export interface ConnectionConnector {
  id: ConnectionInput["connector"];
  parse(input: unknown): ConnectionInput;
  target(input: ConnectionInput): string;
  roots(): PublicationRoot[];
  inspect(owner: string, input: ConnectionInput): Promise<void>;
  test(owner: string, connection: PublicationConnection): Promise<ConnectionTest>;
  credential(input: unknown): Record<string, unknown>;
  ready(connection: PublicationConnection): void;
}
export interface ConnectionSecrets {
  read(owner: string, connection: PublicationConnection): Promise<Record<string, unknown>>;
}
