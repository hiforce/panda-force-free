import type { MemoryMaterialNativeCopy, MemoryPackageMaterial } from "./materials.js";

export const memoryArchiveFormat = "panda-project-knowledge";
export const memoryArchiveVersion = 1;
export const memoryArchiveMaxBytes = 1024 * 1024;
export const memoryPackageExtension = ".pmf";
export const memoryPackageUploadMaxBytes = 1024 * 1024 * 1024;
export const memoryPackageChunkBytes = 1024 * 1024;
export const memoryPackageMediaType = "application/vnd.pandaforce.memory";

export interface MemoryPackageUpload {
  id: string;
  offset: number;
  chunkBytes?: number;
  remote?: boolean;
}

export type MemoryPackageTransferState = "uploading" | "queued" | "checking" | "awaiting-key" | "failed";

export interface MemoryPackageTransfer extends MemoryPackageUpload {
  remote: true;
  name: string;
  size: number;
  checkedBytes: number;
  state: MemoryPackageTransferState;
  envelope?: string;
  retryable?: boolean;
  unsupported?: boolean;
}

export const memoryArchiveMaxRecords = 500;
export const memoryArchiveId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export interface MemoryArchiveEntry {
  key: string;
  scope: string;
  values: string[];
}

export interface MemoryArchive {
  format: typeof memoryArchiveFormat;
  version: typeof memoryArchiveVersion;
  packageId: string;
  createdAt: number;
  records: MemoryArchiveEntry[];
  checksum: string;
}

export interface MemoryArchivePreview {
  packageId: string;
  token: string;
  added: number;
  duplicate: number;
  conflict: number;
  invalid: number;
  imported: boolean;
  withdrawn: boolean;
  records: Array<MemoryArchiveEntry & { action: "added" | "duplicate" | "conflict" }>;
  materials?: MemoryPackageMaterial[];
}

export interface MemoryArchiveImport {
  packageId: string;
  added: number;
  duplicate: number;
  conflict: number;
  invalid: number;
  importedAt: number;
  withdrawn: boolean;
  materials?: MemoryPackageMaterial[];
  copies?: Record<string, MemoryMaterialNativeCopy>;
}
