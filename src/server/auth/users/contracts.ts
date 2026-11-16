import type { StoredPassword } from "../password-store.js";
import type { MetadataStore } from "../../../shared/async-value.js";
import type { SecretEnvelope } from "../../connections/credentials/ports.js";

export type LocalRole = "admin" | "member";
export interface LocalIdentity {
  id: string;
  username: string;
  role: LocalRole;
  owner: string;
  revision: number;
}
export interface LocalUserRecord {
  id: string;
  username: string;
  role: LocalRole;
  enabled: boolean;
  password: StoredPassword | null;
  credentialRevision?: number;
  ownerId?: string;
  recoveryRequest?: { at: number; id: string };
  invitation?: {
    purpose?: "invite" | "bind" | "reset";
    locale?: string;
    digest: string;
    expiresAt: number;
    operationId: string;
    requestedAt?: number;
    code?: {
      envelope: SecretEnvelope;
      attempts: number;
      verifiedAt?: number;
      verificationId?: string;
    };
    delivery: {
      state: "pending" | "sending" | "sent" | "failed";
      envelope: SecretEnvelope | null;
      attempts: number;
      nextAttemptAt: number;
      leaseId?: string;
      leaseUntil?: number;
    };
  };
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface SmtpConfiguration {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  password: SecretEnvelope | null;
  from: string;
  publicUrl: string;
  ca: string;
}
export interface LocalAccountSettings {
  revision: number;
  bootstrapDigest?: string;
  smtp?: SmtpConfiguration;
  administratorEmail?: { email: string; verifiedAt: number };
  binding?: LocalUserRecord;
  administratorPassword?: StoredPassword;
  administratorReset?: LocalUserRecord;
  recoveryRequest?: { at: number; id: string };
}
interface LocalUserOperations {
  list(): LocalUserRecord[];
  get(id: string): LocalUserRecord | null;
  find(username: string): LocalUserRecord | null;
  findChallenge(id: string): LocalUserRecord | null;
  create(record: LocalUserRecord): void;
  update(record: LocalUserRecord, revision: number): void;
  settings(): LocalAccountSettings;
  saveSettings(record: LocalAccountSettings, revision: number): void;
  close(): void;
}
export const LOCAL_MEMBER_CAPACITY = 1000;
export type LocalUserRepository = MetadataStore<LocalUserOperations>;
export class AccountError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super("users." + code);
  }
}
