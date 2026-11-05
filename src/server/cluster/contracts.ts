export interface OwnerLease {
  workspace: string;
  nodeId: string;
  bootId: string;
  address: string;
  fence: number;
  expiresAt: number;
  databaseNow: number;
  released: boolean;
}
export interface JournalEvent {
  sequence: number;
  fence: number;
  data: unknown;
}
export type OperationClaim =
  { kind: "acquired" } | { kind: "completed"; result: unknown } | { kind: "uncertain" } | { kind: "conflict" };
export interface CoordinationStore {
  initialize(): Promise<void>;
  claimOwner(input: {
    workspace: string;
    nodeId: string;
    bootId: string;
    address: string;
    leaseMs: number;
    recoverFence?: number | null;
  }): Promise<OwnerLease>;
  currentOwner(workspace: string): Promise<OwnerLease | null>;
  renew(lease: OwnerLease, leaseMs: number): Promise<OwnerLease>;
  release(lease: OwnerLease): Promise<void>;
  acceptNonce(lease: OwnerLease, nonce: string): Promise<boolean>;
  appendEvent(lease: OwnerLease, data: unknown): Promise<JournalEvent>;
  readEvents(workspace: string, fence: number, after: number, limit?: number): Promise<JournalEvent[]>;
  beginOperation(lease: OwnerLease, id: string, digest: string): Promise<OperationClaim>;
  completeOperation(lease: OwnerLease, id: string, digest: string, result: unknown): Promise<void>;
  close(): Promise<void>;
}
export class ClusterError extends Error {
  constructor(
    message: string,
    readonly code = "cluster_unavailable",
    readonly status = 503,
  ) {
    super(message);
  }
}
