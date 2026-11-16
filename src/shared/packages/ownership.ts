import type { CapturedPackageSource } from "./sources/snapshot.js";

export interface CapturedSourceReader {
  project<T>(actor: string, id: string, read: (source: CapturedPackageSource) => Promise<T>): Promise<T>;
}
export interface CapturedSourceConsumer {
  consume<T>(actor: string, id: string, sha256: string, run: (source: CapturedPackageSource) => Promise<T>): Promise<T>;
}

export interface OwnedSourceReference {
  readonly id: string;
  readonly digest: string;
}
export class OwnedSourceError extends Error {
  constructor(readonly code: "conflict" | "busy" | "capacity" | "unavailable") {
    super(code);
    this.name = "OwnedSourceError";
  }
}
export interface OwnedPackageSources {
  save(actor: string, operationId: string, source: CapturedPackageSource): Promise<OwnedSourceReference>;
  find(actor: string, operationId: string): { ref: OwnedSourceReference; state: string } | null;
  with<T>(actor: string, source: OwnedSourceReference, run: (source: CapturedPackageSource) => Promise<T>): Promise<T>;
  recover(actor: string, operationId: string): Promise<OwnedSourceReference | null>;
  remove(actor: string, operationId: string): Promise<void>;
}
