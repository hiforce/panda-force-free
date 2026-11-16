export interface CredentialBinding {
  connectionId: string;
  connectorId: string;
  ownerId: string;
}
/** Providers return exclusively owned buffers; the cipher erases them after use. */
export interface CredentialKey {
  id: string;
  bytes: Buffer;
}
export interface CredentialKeyProvider {
  load(): Promise<CredentialKey>;
}
export interface SecretEnvelope {
  version: 1;
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}
export interface CredentialMetadata {
  revision: number;
  updatedAt: number;
  refreshState: "ready" | "pending" | "uncertain";
}
export interface CredentialLease {
  owner: string;
  fence: number;
  expiresAt: number;
}
export interface CredentialEncryption {
  seal(binding: CredentialBinding, credential: Record<string, unknown>): Promise<SecretEnvelope>;
  open(binding: CredentialBinding, envelope: SecretEnvelope): Promise<Record<string, unknown>>;
}
export interface CredentialStore {
  count(): number;
  get(binding: CredentialBinding): { metadata: CredentialMetadata; envelope: SecretEnvelope };
  put(
    binding: CredentialBinding,
    expected: number,
    envelope: SecretEnvelope,
    lease?: CredentialLease,
  ): CredentialMetadata;
  acquire(binding: CredentialBinding, revision: number, ttlMs?: number): CredentialLease;
  dispatch(binding: CredentialBinding, lease: CredentialLease): void;
  release(binding: CredentialBinding, lease: CredentialLease): void;
  remove(binding: CredentialBinding, revision: number): void;
}
