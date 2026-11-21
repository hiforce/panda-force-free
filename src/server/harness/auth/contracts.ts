/** Credential snapshots are server-private and must never enter history, catalog responses or logs. */
export interface HarnessCredentialSnapshot {
  credentials: Record<string, unknown>;
  generation: string;
  principal: string;
  expiresAt: number | null;
}

export interface HarnessCredentialSource {
  snapshot(rejectedGeneration?: string): Promise<HarnessCredentialSnapshot>;
}

export interface HarnessCredentialLease {
  prepare(): Promise<void>;
  rejected(): Promise<void>;
  close(): Promise<void>;
}
