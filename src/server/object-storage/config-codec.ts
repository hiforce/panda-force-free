import { registeredStorageId } from "../../shared/workspace-tools/storage.js";
import { originalStorageKinds } from "../../shared/storage/contracts.js";
import type { OriginalStorageMutation, OriginalStorageCredentials } from "../../shared/storage/contracts.js";
import { isRecord } from "../../shared/records.js";
import { ObjectStorageError } from "./contracts.js";
import { validateS3Connection, validateS3Credentials } from "./s3.js";

const fail = (): never => {
  throw new ObjectStorageError("storageInvalidConfiguration");
};
export function storageRecord(value: unknown, keys: readonly string[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return fail();
  return value;
}
export function storageInteger(value: unknown, minimum = 0, maximum = 10_000_000_000) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value < maximum
    ? value
    : fail();
}
export function storageText(value: unknown, limit: number, empty = false) {
  return typeof value === "string" &&
    value.length <= limit &&
    (empty || value.trim().length > 0) &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    ? value
    : fail();
}
export function storageOperationId(value: unknown) {
  const id = storageText(value, 36);
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ? id : fail();
}
export function storageProfileId(value: unknown) {
  const id = storageText(value, 42);
  return /^s-[a-f0-9]{40}$/.test(id) ? id : fail();
}
export function storageTargetId(value: unknown) {
  const id = storageText(value, 42);
  return registeredStorageId.test(id) ? id : storageProfileId(id);
}
export function storageDigest(value: unknown) {
  const digest = storageText(value, 64);
  return /^[a-f0-9]{64}$/.test(digest) ? digest : fail();
}
export function storagePrefix(value: unknown) {
  const prefix = storageText(value, 256, true)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (
    Buffer.byteLength(prefix) > 256 ||
    prefix.includes("\\") ||
    (prefix && prefix.split("/").some((part) => !part || part === "." || part === ".."))
  )
    return fail();
  return prefix;
}
export function storageKinds(value: unknown) {
  if (!Array.isArray(value) || value.length > originalStorageKinds.length) return fail();
  const selected = new Set(value);
  if (selected.size !== value.length || value.some((kind) => !originalStorageKinds.includes(kind))) return fail();
  return originalStorageKinds.filter((kind) => selected.has(kind));
}
export function storageCredentials(value: unknown): OriginalStorageCredentials {
  const input = storageRecord(value, ["accessKeyId", "secretAccessKey", "sessionToken"]);
  return validateS3Credentials({
    accessKeyId: storageText(input.accessKeyId, 256),
    secretAccessKey: storageText(input.secretAccessKey, 2048),
    ...(input.sessionToken !== undefined && input.sessionToken !== ""
      ? { sessionToken: storageText(input.sessionToken, 16384) }
      : {}),
  });
}
export function storageConnection(value: Record<string, unknown>) {
  if (typeof value.forcePathStyle !== "boolean") return fail();
  const region = storageText(value.region, 64),
    endpoint =
      storageText(value.endpoint, 2048, true).trim() ||
      `https://s3.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  return validateS3Connection({
    endpoint,
    region,
    bucket: storageText(value.bucket, 63),
    forcePathStyle: value.forcePathStyle,
  });
}
export function storageMutation(value: unknown): OriginalStorageMutation {
  const input = storageRecord(value, [
      "revision",
      "operationId",
      "action",
      "mode",
      "kinds",
      "profile",
      "profileId",
      "credentialRevision",
      "credentials",
    ]),
    base = { revision: storageInteger(input.revision), operationId: storageOperationId(input.operationId) };
  if (input.action === "credentials") {
    storageRecord(input, ["revision", "operationId", "action", "profileId", "credentialRevision", "credentials"]);
    return {
      ...base,
      action: "credentials",
      profileId: storageProfileId(input.profileId),
      credentialRevision: storageInteger(input.credentialRevision, 1),
      credentials: storageCredentials(input.credentials),
    };
  }
  if (input.action === "placement") {
    storageRecord(input, ["revision", "operationId", "action", "mode", "kinds", "profileId"]);
    const kinds = storageKinds(input.kinds);
    if (input.mode === "local" && input.profileId === undefined)
      return { ...base, action: "placement", mode: "local", kinds };
    if (input.mode === "s3" && kinds.length)
      return { ...base, action: "placement", mode: "s3", kinds, profileId: storageTargetId(input.profileId) };
    return fail();
  }
  storageRecord(input, ["revision", "operationId", "action", "mode", "kinds", "profile"]);
  if (input.action !== "configure" || (input.mode !== "local" && input.mode !== "s3")) return fail();
  const mode = input.mode as "local" | "s3",
    kinds = storageKinds(input.kinds);
  if (mode === "s3" && !kinds.length) return fail();
  let profile: Extract<OriginalStorageMutation, { action: "configure" }>["profile"];
  if (input.profile !== undefined) {
    const p = storageRecord(input.profile, [
      "id",
      "label",
      "endpoint",
      "region",
      "bucket",
      "forcePathStyle",
      "prefix",
      "credentials",
    ]);
    profile = {
      ...storageConnection(p),
      label: storageText(p.label, 120).trim(),
      prefix: storagePrefix(p.prefix),
      ...(p.id !== undefined ? { id: storageProfileId(p.id) } : {}),
      ...(p.credentials !== undefined ? { credentials: storageCredentials(p.credentials) } : {}),
    };
  }
  return { ...base, action: "configure", mode, kinds, ...(profile ? { profile } : {}) };
}
export interface StoredStorageProfile {
  schema: 1;
  id: string;
  label: string;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  prefix: string;
  createdAt: number;
  operationId: string;
  signature: string;
}
export interface StorageProfileReference {
  id: string;
  digest: string;
  credentialId: string;
  credentialRevision: number;
  accessKeyHint: string;
}
export interface StorageConfigurationRecord {
  schema: 1;
  revision: number;
  operationId: string | null;
  signature: string | null;
  mode: "local" | "s3";
  kinds: ReturnType<typeof storageKinds>;
  activeProfileId: string | null;
  profiles: StorageProfileReference[];
}
export function storedStorageProfile(value: unknown): StoredStorageProfile {
  const p = storageRecord(value, [
    "schema",
    "id",
    "label",
    "endpoint",
    "region",
    "bucket",
    "forcePathStyle",
    "prefix",
    "createdAt",
    "operationId",
    "signature",
  ]);
  if (p.schema !== 1) return fail();
  return {
    schema: 1,
    ...storageConnection(p),
    id: storageProfileId(p.id),
    label: storageText(p.label, 120),
    prefix: storagePrefix(p.prefix),
    createdAt: storageInteger(p.createdAt, 1, Number.MAX_SAFE_INTEGER),
    operationId: storageOperationId(p.operationId),
    signature: storageDigest(p.signature),
  };
}
export function storageConfigurationRecord(value: unknown): StorageConfigurationRecord {
  const r = storageRecord(value, [
    "schema",
    "revision",
    "operationId",
    "signature",
    "mode",
    "kinds",
    "activeProfileId",
    "profiles",
  ]);
  if (
    r.schema !== 1 ||
    (r.mode !== "local" && r.mode !== "s3") ||
    !Array.isArray(r.profiles) ||
    r.profiles.length > 128
  )
    return fail();
  const profiles = r.profiles.map((value) => {
      const p = storageRecord(value, ["id", "digest", "credentialId", "credentialRevision", "accessKeyHint"]);
      return {
        id: storageProfileId(p.id),
        digest: storageDigest(p.digest),
        credentialId: storageOperationId(p.credentialId),
        credentialRevision: storageInteger(p.credentialRevision, 1),
        accessKeyHint: storageText(p.accessKeyHint, 4),
      };
    }),
    activeProfileId = r.activeProfileId === null ? null : storageTargetId(r.activeProfileId),
    revision = storageInteger(r.revision, 1),
    kinds = storageKinds(r.kinds);
  if (
    new Set(profiles.map((p) => p.id)).size !== profiles.length ||
    (activeProfileId &&
      !registeredStorageId.test(activeProfileId) &&
      !profiles.some((p) => p.id === activeProfileId)) ||
    (r.mode === "s3" && (!activeProfileId || !kinds.length))
  )
    return fail();
  return {
    schema: 1,
    revision,
    mode: r.mode as "local" | "s3",
    kinds,
    activeProfileId,
    profiles,
    operationId: storageOperationId(r.operationId),
    signature: storageDigest(r.signature),
  };
}
