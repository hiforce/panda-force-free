import type { CreativeResource } from "../../shared/creative/assets.js";
import type { S3ObjectReceipt } from "./contracts.js";
import { ObjectStorageError } from "./contracts.js";
import {
  storageDigest,
  storageInteger,
  storageOperationId,
  storageProfileId,
  storageRecord,
  storageText,
} from "./config-codec.js";

export interface OriginalScope {
  ownerId: string;
  projectId: string;
  assetId: string;
}
export interface StoredOriginalScope extends OriginalScope {
  schema: 1;
  scope: string;
}
export interface OriginalUploadIntent {
  schema: 1;
  scope: string;
  digest: string;
  size: number;
  id: string;
  profileId: string;
  profileDigest: string;
  key: string;
  signature: string;
}
export function originalIntegrity(): never {
  throw new ObjectStorageError("storageIntegrity");
}
export function originalScope(input: OriginalScope): OriginalScope {
  const ownerId = storageOperationId(input.ownerId),
    projectId = storageText(input.projectId, 128),
    assetId = storageText(input.assetId, 38);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(projectId) ||
    !/^c-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(assetId)
  )
    originalIntegrity();
  return { ownerId, projectId, assetId };
}
export function storedOriginalScope(value: unknown): StoredOriginalScope {
  const v = storageRecord(value, ["schema", "scope", "ownerId", "projectId", "assetId"]);
  if (v.schema !== 1) originalIntegrity();
  return { schema: 1, scope: storageDigest(v.scope), ...originalScope(v as unknown as OriginalScope) };
}
export function originalDescriptor(value: CreativeResource) {
  return { digest: storageDigest(value.digest), size: storageInteger(value.size, 0, 32 * 1024 * 1024 + 1) };
}
export function originalUploadIntent(value: unknown): OriginalUploadIntent {
  const v = storageRecord(value, [
    "schema",
    "scope",
    "digest",
    "size",
    "id",
    "profileId",
    "profileDigest",
    "key",
    "signature",
  ]);
  if (v.schema !== 1) originalIntegrity();
  const key = storageText(v.key, 1024);
  if (key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) originalIntegrity();
  return {
    schema: 1,
    scope: storageDigest(v.scope),
    digest: storageDigest(v.digest),
    size: storageInteger(v.size, 0, 32 * 1024 * 1024 + 1),
    id: storageOperationId(v.id),
    profileId: storageProfileId(v.profileId),
    profileDigest: storageDigest(v.profileDigest),
    key,
    signature: storageDigest(v.signature),
  };
}
export function originalObjectReceipt(value: unknown): S3ObjectReceipt {
  const v = storageRecord(value, ["versionId", "etag", "size", "digest", "intentId"]),
    versionId = storageText(v.versionId, 2048),
    etag = storageText(v.etag, 130);
  if (!/^[\x21-\x7e]+$/.test(versionId) || !/^"[A-Za-z0-9._-]{1,128}"$/.test(etag)) originalIntegrity();
  return {
    versionId,
    etag,
    size: storageInteger(v.size, 0, 32 * 1024 * 1024 + 1),
    digest: storageDigest(v.digest),
    intentId: storageOperationId(v.intentId),
  };
}
