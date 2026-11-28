export const storageToolsPath = "/tools/storage";
export const storageConnectionsPath = "/api/system/storage-connections";
export const googleStorageCallbackPath = storageConnectionsPath + "/google/callback";
export const googleStorageCompletePath = storageConnectionsPath + "/google/complete";

export const registeredStorageId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const storageProviders = ["s3", "oss", "google-drive"] as const;
export type StorageProvider = (typeof storageProviders)[number];

export type RegisteredStorageConnection = {
  id: string;
  name: string;
} & (
  | {
      provider: "s3" | "oss";
      endpoint: string;
      bucket: string;
      region: string;
      prefix: string;
      forcePathStyle: boolean;
      credentialRevision?: number;
      originalStorage?: "active" | "retained";
    }
  | { provider: "google-drive"; account: string }
);
