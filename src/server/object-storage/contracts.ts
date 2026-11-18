import type {
  OriginalStorageConnection,
  OriginalStorageCredentials,
  OriginalStorageErrorCode,
} from "../../shared/storage/contracts.js";
/** Remote locations and credentials are server-owned and never part of a creative asset's public descriptor. */
export type S3Connection = OriginalStorageConnection;
export type S3Credentials = OriginalStorageCredentials;
export interface S3ObjectReceipt {
  versionId: string;
  etag: string;
  size: number;
  digest: string;
  intentId: string;
}
export type ObjectStorageFailure = OriginalStorageErrorCode;
export class ObjectStorageError extends Error {
  constructor(
    readonly code: ObjectStorageFailure,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(code);
    this.name = "ObjectStorageError";
  }
}
