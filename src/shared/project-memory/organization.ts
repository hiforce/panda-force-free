import type { OrganizedMemoryRelationKind } from "./contracts.js";

export interface MemoryOrganizationSource {
  id: string;
  user: string;
  assistant?: string;
}

export interface MemoryOrganizationRelation {
  key: string;
  scope: string;
  kind: OrganizedMemoryRelationKind;
}

export interface MemoryOrganizationEntry {
  key: string;
  scope: string;
  title?: string;
  value: string | null;
  version: string | null;
  relations?: ReadonlyArray<MemoryOrganizationRelation>;
}

export interface MemoryOrganizationContext {
  job: string;
  language?: { tag: string; name: string };
  sources: readonly MemoryOrganizationSource[];
  existing: ReadonlyArray<MemoryOrganizationEntry>;
}

export const memoryOrganizationOutputLimit = 24 * 1024;

export interface MemoryOrganizationCli {
  context(job: string): MemoryOrganizationContext;
  submit(job: string, payload: unknown): { accepted: number };
}
