import type { CliClientKind, CliGrant } from "../../../shared/cli/contracts.js";
export interface CliClientRecord {
  id: string;
  owner: string;
  name: string;
  kind: CliClientKind;
  createdAt: number;
  revokedAt: number | null;
}
export interface CliKeyRecord extends CliGrant {
  digest: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}
export interface CliCredentialStore {
  issue(client: CliClientRecord, key: CliKeyRecord): void | Promise<void>;
  find(
    keyId: string,
  ):
    | { client: CliClientRecord; key: CliKeyRecord }
    | null
    | Promise<{ client: CliClientRecord; key: CliKeyRecord } | null>;
  list(
    owner: string,
  ): { client: CliClientRecord; key: CliKeyRecord }[] | Promise<{ client: CliClientRecord; key: CliKeyRecord }[]>;
  touch(keyId: string, now: number): void | Promise<void>;
  revoke(owner: string, clientId: string, now: number): void | Promise<void>;
}
