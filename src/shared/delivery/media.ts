/** A platform asset is bound to its authenticated account and is not a publication receipt. */
export interface UploadedMedia {
  mediaId: string;
  /** Returned by the provider; older receipts deliberately leave this unknown. */
  mediaKey?: string;
  accountId: string;
  category: "tweet_image";
  state: "pending" | "in_progress" | "failed" | "succeeded";
  expiresAt: number | null;
  checkAt: number | null;
  progress: number | null;
  observedAt: number;
}

/** Immutable, document-owned bytes and the exact source occurrence selected by review. */
export interface PublicationImage {
  key: string;
  assetId: string;
  source: string;
  blockId: string;
  name: string;
  mime: string;
  digest: string;
  size: number;
  alt: string;
}
