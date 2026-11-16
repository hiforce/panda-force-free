import type { IndexReference } from "../ports.js";

/** Physical identity is opaque: an upstream int64 must never pass through a rounded JavaScript number. */
export interface PhysicalIndexResource {
  name: string;
  identity: string;
  marker: string;
}
export interface IndexResourceAllocation {
  storage: string;
  name: string;
  recipe: string;
  marker: string;
  identity: string | null;
  state: "building" | "ready" | "retiring" | "deleted" | "unverified";
  reference: string | null;
  token: string | null;
  leaseUntil: number;
  orphanSince: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface IndexResourceTicket {
  storage: string;
  name: string;
  token: string;
}
export interface IndexResourceOwnership {
  reserve(storage: string, name: string, recipe: string, marker: string): IndexResourceAllocation;
  heartbeat(ticket: IndexResourceTicket): boolean;
  release(ticket: IndexResourceTicket): void;
  seal(ticket: IndexResourceTicket, physical: PhysicalIndexResource, reference: IndexReference): boolean;
}
export interface IndexResourceRegistry extends IndexResourceOwnership {
  get(storage: string, name: string): IndexResourceAllocation | null;
  page(storage: string, after?: string): { name: string }[];
  observe(storage: string, name: string, physical: PhysicalIndexResource | null): IndexResourceAllocation | null;
  protected(row: IndexResourceAllocation): boolean;
  pin(storage: string, name: string): IndexResourceTicket;
  heartbeatRead(ticket: IndexResourceTicket): boolean;
  unpin(ticket: IndexResourceTicket): void;
  claimDrop(
    storage: string,
    name: string,
    physical: PhysicalIndexResource | null,
    immediate?: boolean,
  ): IndexResourceTicket | null;
  mayDrop(ticket: IndexResourceTicket, physical: PhysicalIndexResource | null): boolean;
  deleted(ticket: IndexResourceTicket): boolean;
}
export interface PhysicalIndexStorage {
  readonly id: string;
  inspect(name: string, signal: AbortSignal): Promise<PhysicalIndexResource | null>;
  remove(name: string, signal: AbortSignal): Promise<void>;
  inventory(
    after: string,
    signal: AbortSignal,
  ): Promise<{ names: string[]; next: string | null; ownedNamespaceCount: number }>;
}
