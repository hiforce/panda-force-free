export interface SourceUploadIdentity {
  readonly bytes: number;
  readonly sha256: string;
}
export interface SourceUploadBody {
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Stop the producer without waiting for a possibly stalled iterator to return. */
  cancel(): void;
  /** Trusted transport adapters declare additional buffering required by authenticated forwarding. */
  readonly bufferedBytes?: number;
}
