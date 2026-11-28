import { CREATIVE_ASSET_KINDS } from "../creative/assets.js";

export const originalStorageKinds = [...CREATIVE_ASSET_KINDS, "project-memory-package"] as const;
export type OriginalStorageKind = (typeof originalStorageKinds)[number];

export type OriginalStorageErrorCode =
  | "storageInvalidConfiguration"
  | "storageUnavailable"
  | "storageDenied"
  | "storageConflict"
  | "storageTooLarge"
  | "storageIntegrity"
  | "storageAdministratorRequired"
  | "storageAuthenticationRequired";

export interface OriginalStorageConnection {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
}
export interface OriginalStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export interface OriginalStorageProfile extends OriginalStorageConnection {
  id: string;
  label: string;
  prefix: string;
  credentialRevision: number;
  accessKeyHint: string;
}
export interface OriginalStorageSettings {
  schema: 1;
  revision: number;
  mode: "local" | "s3";
  kinds: OriginalStorageKind[];
  activeProfileId: string | null;
  profiles: OriginalStorageProfile[];
  operationId: string | null;
}
export interface OriginalStorageOperation {
  id: string;
  state: "saved" | "not-saved" | "pending";
  savedRevision: number | null;
  currentRevision: number;
}
export type OriginalStorageMutation = {
  revision: number;
  operationId: string;
} & (
  | {
      action: "configure";
      mode: "local" | "s3";
      kinds: OriginalStorageKind[];
      profile?: OriginalStorageConnection & {
        id?: string;
        label: string;
        prefix: string;
        credentials?: OriginalStorageCredentials;
      };
    }
  | ({ action: "placement"; kinds: OriginalStorageKind[] } & ({ mode: "local" } | { mode: "s3"; profileId: string }))
  | {
      action: "credentials";
      profileId: string;
      credentialRevision: number;
      credentials: OriginalStorageCredentials;
    }
);
