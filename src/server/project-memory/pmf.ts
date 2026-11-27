import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { zipSync } from "fflate";
import { HarnessError } from "../../shared/harness/contracts.js";
import { memoryArchiveMaxBytes, type MemoryArchive } from "../../shared/project-memory/archive.js";
import {
  pmfVersion,
  pmfFingerprintBytes,
  pmfHeaderBytes,
  pmfMagic,
  pmfMinimumBytes,
  pmfNonceBytes,
  pmfTagBytes,
  pmfWrappedKeyBytes,
} from "../../shared/project-memory/pmf-envelope.js";
import { SourceError } from "../../shared/packages/sources/contracts.js";
import { zipDirectory } from "../packages/zip/headers.js";
import { zipPayloads } from "../packages/zip/layout.js";
import { decodeZipPayload } from "../packages/zip/payload.js";

const manifestPath = "manifest.json";
const archiveBytes = memoryArchiveMaxBytes + 256 * 1024;
export const structuredMemoryPackageMaxBytes = archiveBytes + pmfHeaderBytes + pmfTagBytes;
const limits = {
  archiveBytes,
  fileBytes: memoryArchiveMaxBytes,
  totalBytes: memoryArchiveMaxBytes,
  files: 1,
  entries: 1,
};

export class MemoryPackageError extends Error {
  constructor(
    readonly messageId:
      "projects.memoryPackageInvalid" | "projects.memoryPackageUnsupported" | "projects.memoryPackageUnlockFailed",
  ) {
    super(messageId);
  }
}

export function memoryPackageRecipient(input: unknown) {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{400,640}$/u.test(input)) throw new HarnessError("invalidInput");
  try {
    const key = createPublicKey({ key: Buffer.from(input, "base64url"), format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 3072 ||
      key.asymmetricKeyDetails.publicExponent !== BigInt(65537)
    )
      throw new Error("Invalid RSA key");
    return key;
  } catch {
    throw new HarnessError("invalidInput");
  }
}

export function memoryEnvelope(recipient: KeyObject, content: Buffer, magic: Uint8Array, nonce: Buffer) {
  const wrapped = publicEncrypt(
    { key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    content,
  );
  const fingerprint = createHash("sha256")
    .update(recipient.export({ type: "spki", format: "der" }))
    .digest();
  return Buffer.concat([magic, fingerprint, wrapped, nonce]);
}

export function sealMemoryPackage(recipient: KeyObject, zip: Uint8Array) {
  const content = randomBytes(32);
  try {
    const nonce = randomBytes(pmfNonceBytes);
    const header = memoryEnvelope(recipient, content, pmfMagic, nonce);
    const cipher = createCipheriv("aes-256-gcm", content, nonce);
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(zip), cipher.final(), cipher.getAuthTag()]);
  } finally {
    content.fill(0);
  }
}

export function encodeMemoryPackage(archive: MemoryArchive, recipient: KeyObject) {
  const manifest = Buffer.from(JSON.stringify(archive));
  if (manifest.length > memoryArchiveMaxBytes) throw new HarnessError("contextTooLarge", 413);
  return sealMemoryPackage(
    recipient,
    zipSync({ [manifestPath]: manifest }, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") }),
  );
}

export async function decodeMemoryPackage(
  size: number,
  read: (offset: number, length: number) => Promise<Buffer>,
  key: Buffer,
) {
  if (size < pmfMinimumBytes) throw new MemoryPackageError("projects.memoryPackageInvalid");
  if (size > structuredMemoryPackageMaxBytes) throw new MemoryPackageError("projects.memoryPackageUnsupported");
  const bytes = await read(0, size);
  if (pmfVersion(bytes) !== 1) throw new MemoryPackageError("projects.memoryPackageInvalid");
  const nonceOffset = pmfMagic.length + pmfFingerprintBytes + pmfWrappedKeyBytes;
  const tagOffset = size - pmfTagBytes;
  let zip: Buffer;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(nonceOffset, pmfHeaderBytes));
    cipher.setAAD(bytes.subarray(0, pmfHeaderBytes));
    cipher.setAuthTag(bytes.subarray(tagOffset));
    zip = Buffer.concat([cipher.update(bytes.subarray(pmfHeaderBytes, tagOffset)), cipher.final()]);
  } catch {
    throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
  }
  try {
    const [payload] = zipPayloads(zip, zipDirectory(zip, limits));
    if (!payload || payload.entry.directory || payload.entry.path !== manifestPath)
      throw new MemoryPackageError("projects.memoryPackageInvalid");
    const manifest = await decodeZipPayload(zip, payload);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest));
    return value;
  } catch (error) {
    if (error instanceof SourceError && error.code === "sourceTooLarge")
      throw new MemoryPackageError("projects.memoryPackageUnsupported");
    throw new MemoryPackageError("projects.memoryPackageInvalid");
  }
}
