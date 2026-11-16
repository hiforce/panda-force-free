import type { OwnedSourceReference } from "../../../shared/packages/ownership.js";

export type VersionNamespace = "native_theme" | "native_slides";
export type VersionErrorCode =
  "invalidInput" | "unavailable" | "conflict" | "notFound" | "immutableVersion" | "storageFull" | "disabled";
export interface VersionDescriptor<D> {
  readonly data: D;
  readonly digest: string;
}
export interface InstalledVersion<D> {
  id: string;
  version: string;
  digest: string;
  descriptor: D;
  enabled: boolean;
  active: boolean;
  installedAt: number;
}
export interface VersionIntent<D, R> {
  actor: string;
  operationId: string;
  signature: string;
  state: "pending" | "committed" | "failed";
  expectedRevision: number;
  descriptor: D | null;
  digest: string;
  receipt: R | null;
  cleaned: boolean;
  recoverAfter: number;
}
export interface VersionReceiptContext<D> {
  descriptor: D;
  operationId: string;
  revision: number;
  digest: string;
  settingsDigest: string;
  status: "installed" | "retained";
}
export interface VersionPolicy<D, R> {
  maxBytes: number;
  trusted(value: unknown): value is VersionDescriptor<D>;
  parse(value: unknown): D;
  identity(value: D): { id: string; version: string; sourceDigest: string };
  receipt(value: VersionReceiptContext<D>): R;
}
export interface ImmutableVersions<D, R> {
  snapshot(actor: string): { revision: number; versions: InstalledVersion<D>[] };
  detail(actor: string, id: string, version: string): InstalledVersion<D>;
  source(actor: string, id: string, version: string): OwnedSourceReference;
  operation(actor: string, id: string): VersionIntent<D, R> | null;
  reserve(
    actor: string,
    signature: string,
    value: VersionDescriptor<D>,
    approval: { operationId: string; expectedRevision: number },
    settingsDigest: string,
  ): VersionIntent<D, R>;
  commit(actor: string, id: string, source: OwnedSourceReference): R;
  fail(actor: string, id: string): void;
  cleanupDone(actor: string, id: string): void;
  recoverable(): VersionIntent<D, R>[];
  referenced(actor: string, sourceId: string): boolean;
  state(
    actor: string,
    id: string,
    version: string,
    digest: string,
    action: "enable" | "disable" | "activate",
    revision: number,
  ): InstalledVersion<D>;
}
