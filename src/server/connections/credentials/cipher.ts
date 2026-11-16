import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  CredentialBinding,
  CredentialKey,
  CredentialKeyProvider,
  SecretEnvelope,
  CredentialEncryption,
} from "./ports.js";
import { CredentialError } from "./errors.js";

const maximum = 64 * 1024;
function binding({ connectionId, connectorId, ownerId }: CredentialBinding) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(connectionId) ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(connectorId)
  )
    throw new CredentialError("invalidCredential");
  if (
    typeof ownerId !== "string" ||
    !ownerId ||
    ownerId.length > 256 ||
    [...ownerId].some((character) => character.charCodeAt(0) < 32)
  )
    throw new CredentialError("invalidCredential");
  return Buffer.from(JSON.stringify(["panda-force.connection", 1, connectionId, connectorId, ownerId]));
}
function binary(value: unknown, size?: number) {
  if (typeof value !== "string" || value.length > maximum * 1.4) throw new CredentialError("unreadableCredential");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size))
    throw new CredentialError("unreadableCredential");
  return bytes;
}

/** Encryption has no knowledge of database rows, HTTP, account permissions, or connector execution. */
export class CredentialCipher implements CredentialEncryption {
  constructor(private keys: CredentialKeyProvider) {}
  async seal(scope: CredentialBinding, credential: Record<string, unknown>): Promise<SecretEnvelope> {
    const aad = binding(scope);
    if (!credential || typeof credential !== "object" || Array.isArray(credential))
      throw new CredentialError("invalidCredential");
    let plain: Buffer;
    try {
      plain = Buffer.from(JSON.stringify(credential));
    } catch {
      throw new CredentialError("invalidCredential");
    }
    if (plain.length > maximum) {
      plain.fill(0);
      throw new CredentialError("invalidCredential");
    }
    let key: CredentialKey | undefined;
    try {
      key = await this.keys.load();
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key.bytes, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return {
        version: 1,
        keyId: key.id,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    } finally {
      plain.fill(0);
      key?.bytes.fill(0);
    }
  }
  async open(scope: CredentialBinding, envelope: SecretEnvelope): Promise<Record<string, unknown>> {
    const aad = binding(scope);
    if (!envelope || envelope.version !== 1) throw new CredentialError("unreadableCredential");
    const nonce = binary(envelope.nonce, 12),
      tag = binary(envelope.tag, 16),
      ciphertext = binary(envelope.ciphertext);
    const key = await this.keys.load();
    let plain: Buffer | undefined;
    try {
      if (key.id !== envelope.keyId) throw new CredentialError("keyUnavailable");
      const decipher = createDecipheriv("aes-256-gcm", key.bytes, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plain.length > maximum) throw new CredentialError("unreadableCredential");
      const value: unknown = JSON.parse(plain.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new CredentialError("unreadableCredential");
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError("unreadableCredential");
    } finally {
      plain?.fill(0);
      key.bytes.fill(0);
    }
  }
}
