export interface SourceResource {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface SourceFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface SourceLimits {
  readonly archiveBytes: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly files: number;
  readonly entries: number;
}
export const DEFAULT_SOURCE_LIMITS: SourceLimits = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 4096,
  entries: 8192,
});
export type SourceErrorCode =
  | "invalidSourcePath"
  | "duplicateSourcePath"
  | "sourceTooLarge"
  | "invalidArchive"
  | "unsupportedArchive"
  | "invalidSource"
  | "sourceUnavailable"
  | "sourceCancelled"
  | "sourceTimedOut"
  | "sourceAccessDenied"
  | "sourceRateLimited"
  | "sourceInventoryIncomplete"
  | "sourceChanged"
  | "unsupportedSourceEntry";
export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
    this.name = "SourceError";
  }
}
export function sourceLimits(value: SourceLimits = DEFAULT_SOURCE_LIMITS): SourceLimits {
  const captured = Object.freeze({ ...value });
  if (
    Object.keys(captured).length !== Object.keys(DEFAULT_SOURCE_LIMITS).length ||
    Object.keys(DEFAULT_SOURCE_LIMITS).some((key) => {
      const number = captured[key as keyof SourceLimits];
      return !Number.isSafeInteger(number) || number <= 0;
    })
  )
    throw new SourceError("invalidSource");
  return captured;
}

export type PackageSourceOrigin =
  | { readonly kind: "zip-upload"; readonly name: string; readonly archiveSha256: string }
  | {
      readonly kind: "github";
      readonly repository: string;
      readonly repositoryId: number;
      readonly requestedRef: string;
      readonly commit: string;
      readonly tree: string;
      readonly root: string;
    };
export interface PackageSourceFile {
  readonly path: string;
  readonly bytes: number;
  readonly integrity: { readonly algorithm: "sha256" | "git-blob-sha1"; readonly value: string };
}
export type SourceEntryPolicy = "regular-only/v1" | "logical-links/v2";
