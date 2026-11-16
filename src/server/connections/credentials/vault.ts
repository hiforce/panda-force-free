import type { CredentialBinding, CredentialStore, CredentialEncryption } from "./ports.js";
import { CredentialError } from "./errors.js";

/** Internal service for already-authorized connections. HTTP and plugin callers never receive this object. */
export class ConnectionVault {
  constructor(
    private repository: CredentialStore,
    private cipher: CredentialEncryption,
  ) {}
  metadata(binding: CredentialBinding) {
    return this.repository.get(binding).metadata;
  }
  async read(binding: CredentialBinding) {
    const { metadata, envelope } = this.repository.get(binding);
    if (metadata.refreshState !== "ready")
      throw new CredentialError(metadata.refreshState === "pending" ? "refreshBusy" : "refreshFailed");
    const credential = await this.cipher.open(binding, envelope);
    const current = this.repository.get(binding).metadata;
    if (current.revision !== metadata.revision) throw new CredentialError("credentialConflict");
    if (current.refreshState !== "ready")
      throw new CredentialError(current.refreshState === "pending" ? "refreshBusy" : "refreshFailed");
    return { revision: metadata.revision, credential };
  }
  async write(binding: CredentialBinding, credential: Record<string, unknown>, expectedRevision: number) {
    const envelope = await this.cipher.seal(binding, credential);
    return this.repository.put(binding, expectedRevision, envelope);
  }
  remove(binding: CredentialBinding, revision: number) {
    this.repository.remove(binding, revision);
  }
  async refresh(
    binding: CredentialBinding,
    revision: number,
    exchange: (credential: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    const lease = this.repository.acquire(binding, revision);
    try {
      const saved = await this.read(binding);
      if (saved.revision !== revision) throw new CredentialError("credentialConflict");
      this.repository.dispatch(binding, lease);
      let updated: Record<string, unknown>;
      try {
        updated = await exchange(saved.credential);
      } catch {
        throw new CredentialError("refreshFailed");
      }
      const envelope = await this.cipher.seal(binding, updated);
      return this.repository.put(binding, revision, envelope, lease);
    } finally {
      this.repository.release(binding, lease);
    }
  }
}
