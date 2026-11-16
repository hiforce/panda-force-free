import { createHash } from "node:crypto";
import type { InstalledVersion, VersionIntent, VersionPolicy, VersionErrorCode } from "./contracts.js";

export type VersionRow = {
  actor: string;
  id: string;
  version: string;
  digest: string;
  descriptor: string;
  sourceId: string;
  enabled: number;
  installedAt: number;
  active: number;
};
export type VersionOperationRow = {
  actor: string;
  operationId: string;
  signature: string;
  state: "pending" | "committed" | "failed";
  expectedRevision: number;
  descriptor: string | null;
  digest: string;
  receipt: string | null;
  cleaned: number;
  settingsDigest: string;
  createdAt: number;
};
export class VersionRecords<D, R> {
  constructor(
    private policy: VersionPolicy<D, R>,
    private error: (code: VersionErrorCode) => Error,
  ) {}
  metadata(raw: string, digest: string): D {
    try {
      if (Buffer.byteLength(raw) > this.policy.maxBytes) throw Error();
      const data = this.policy.parse(JSON.parse(raw));
      if (JSON.stringify(data) !== raw || createHash("sha256").update(raw).digest("hex") !== digest) throw Error();
      return data;
    } catch {
      throw this.error("unavailable");
    }
  }
  installed(row: VersionRow): InstalledVersion<D> {
    const descriptor = this.metadata(row.descriptor, row.digest),
      identity = this.policy.identity(descriptor);
    if (identity.id !== row.id || identity.version !== row.version) throw this.error("unavailable");
    return {
      id: row.id,
      version: row.version,
      digest: row.digest,
      descriptor,
      enabled: !!row.enabled,
      active: !!row.active,
      installedAt: row.installedAt,
    };
  }
  intent(row: VersionOperationRow): VersionIntent<D, R> {
    return {
      actor: row.actor,
      operationId: row.operationId,
      signature: row.signature,
      state: row.state,
      expectedRevision: row.expectedRevision,
      descriptor: row.descriptor ? this.metadata(row.descriptor, row.digest) : null,
      digest: row.digest,
      receipt: row.receipt ? (JSON.parse(row.receipt) as R) : null,
      cleaned: !!row.cleaned,
      recoverAfter: row.createdAt + 180000,
    };
  }
}
