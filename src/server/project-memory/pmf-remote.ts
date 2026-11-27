import { randomUUID } from "node:crypto";
import { errorCode, errorStatus } from "../../shared/errors.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import {
  memoryPackageExtension,
  memoryPackageUploadMaxBytes,
  type MemoryPackageTransfer,
  type MemoryPackageTransferState,
} from "../../shared/project-memory/archive.js";
import { isPmf, pmfHeaderBytes, pmfMinimumBytes, pmfVersion } from "../../shared/project-memory/pmf-envelope.js";
import type { HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import type { OriginalStorageConfiguration } from "../object-storage/configuration.js";
import { ObjectStorageError } from "../object-storage/contracts.js";
import { s3MultipartPartBytes, type S3MultipartObject } from "../object-storage/multipart.js";
import { storageSha256 } from "../object-storage/sigv4.js";
import { decodeMemoryPackage, MemoryPackageError, structuredMemoryPackageMaxBytes } from "./pmf.js";
import { openMemoryMaterials, type OpenMemoryMaterials } from "./pmf-materials.js";
import type { MemoryArchiveAuthorize } from "./portability.js";
import { namespace } from "./records.js";

const kind = "project-memory-package-upload";
const rowId = (id: string) => kind + ":" + id;
const uploadTtl = 24 * 60 * 60_000;
const leaseMs = 120_000;
const maxAttempts = 5;

interface Chunk {
  size: number;
  digest: string;
  etag: string;
}

interface Upload {
  id: string;
  owner: string;
  project: string;
  name: string;
  size: number;
  offset: number;
  checked: number;
  envelope?: string;
  objectKey: string;
  profile: string;
  profileDigest: string;
  uploadId?: string;
  object?: S3MultipartObject;
  chunks: Chunk[];
  pendingDigest?: string;
  leaseUntil?: number;
  state: MemoryPackageTransferState | "cleanup";
  retryable?: boolean;
  unsupported?: boolean;
  attempts: number;
}

function upload(row: HarnessRecord) {
  return JSON.parse(row.data) as Upload;
}

function view(item: Upload): MemoryPackageTransfer {
  if (item.state === "cleanup") throw new HarnessError("notFound", 404);
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    remote: true,
    chunkBytes: s3MultipartPartBytes,
    offset: item.offset,
    checkedBytes: Math.min(item.checked * s3MultipartPartBytes, item.size),
    state: item.state,
    ...(item.envelope && ["awaiting-key", "uploading"].includes(item.state) ? { envelope: item.envelope } : {}),
    ...(item.state === "failed" ? { retryable: item.retryable, unsupported: item.unsupported } : {}),
  };
}

const conflict = () => new HarnessError("conflict", 409);
const notFound = () => new HarnessError("notFound", 404);

export class RemoteMemoryPackages {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = new AbortController();

  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly storage: Pick<
      OriginalStorageConfiguration,
      "memoryPackageTarget" | "memoryPackagesEnabled" | "client"
    >,
    private readonly authorize: MemoryArchiveAuthorize,
    private readonly now = Date.now,
  ) {}

  private async store(tx: HarnessMetadataTransaction, data: Upload, current: HarnessRecord | null, due: number) {
    const row = {
      id: rowId(data.id),
      kind,
      owner: namespace(data.owner, data.project),
      revision: (current?.revision ?? 0) + 1,
      data: JSON.stringify(data),
      updatedAt: due,
    };
    await tx.put(row, current?.revision ?? null);
    return row;
  }

  private owned(row: HarnessRecord | null, owner: string, project: string) {
    if (!row || row.owner !== namespace(owner, project)) return null;
    const item = upload(row);
    if (item.owner !== owner || item.project !== project) throw notFound();
    return { row, item };
  }

  private async multipart(item: Upload) {
    return (await this.storage.client(item.profile, item.profileDigest)).client.multipart();
  }

  async startUpload(owner: string, project: string, name: unknown, size: unknown) {
    const target = await this.storage.memoryPackageTarget();
    if (!target) return null;
    if (
      typeof name !== "string" ||
      !name.toLowerCase().endsWith(memoryPackageExtension) ||
      /[\\/\p{Cc}\p{Cf}]/u.test(name) ||
      name.length > 256
    )
      throw new MemoryPackageError("projects.memoryPackageInvalid");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < pmfMinimumBytes)
      throw new HarnessError("invalidInput");
    if (size > memoryPackageUploadMaxBytes) throw new HarnessError("contextTooLarge", 413);
    const id = randomUUID();
    const item: Upload = {
      id,
      owner,
      project,
      name,
      size,
      offset: 0,
      checked: 0,
      objectKey: [target.profile.prefix, "panda-memory-packages", target.installation, id + memoryPackageExtension]
        .filter(Boolean)
        .join("/"),
      profile: target.profile.id,
      profileDigest: target.digest,
      state: "uploading",
      attempts: 0,
      chunks: [],
    };
    await this.metadata.transaction(async (tx) => {
      const current = await tx.list(kind, namespace(owner, project), { limit: 16 });
      if (current.length >= 16) throw new HarnessError("busy", 409);
      await this.store(tx, item, null, this.now() + uploadTtl);
    });
    return view(item);
  }

  async available() {
    return this.storage.memoryPackagesEnabled();
  }

  async list(owner: string, project: string) {
    const current = await this.metadata.list(kind, namespace(owner, project), { limit: 16 });
    return current
      .map(upload)
      .filter((item) => item.state !== "cleanup")
      .map(view);
  }

  async status(owner: string, project: string, id: string) {
    const found = this.owned(await this.metadata.read(rowId(id)), owner, project);
    return found ? view(found.item) : null;
  }

  async append(owner: string, project: string, id: string, offset: number, bytes: Buffer) {
    const digest = storageSha256(bytes);
    let { row, item } = await this.metadata.transaction(async (tx) => {
      const found = this.owned(await tx.get(rowId(id)), owner, project);
      if (!found) throw notFound();
      const { item } = found;
      if (item.state !== "uploading" || item.offset !== offset || (item.leaseUntil ?? 0) > this.now()) throw conflict();
      if (item.pendingDigest && item.pendingDigest !== digest) throw conflict();
      const expected = Math.min(item.size - item.offset, s3MultipartPartBytes);
      if (!expected || bytes.length !== expected) throw new HarnessError("invalidInput");
      if (!offset && !isPmf(bytes)) throw new MemoryPackageError("projects.memoryPackageInvalid");
      item.pendingDigest = digest;
      item.leaseUntil = this.now() + leaseMs;
      return { row: await this.store(tx, item, found.row, this.now() + uploadTtl), item };
    });
    const signal = this.stopping.signal;
    try {
      const s3 = await this.multipart(item);
      if (!item.uploadId) {
        const [recovered, ...strays] = await s3.list(item.objectKey, signal);
        for (const stray of strays) await s3.abort(item.objectKey, stray, signal);
        const uploadId = recovered ?? (await s3.start(item.objectKey, item.id, signal));
        item = { ...item, uploadId };
        row = await this.metadata.transaction(async (tx) => {
          if ((await tx.get(row.id))?.revision !== row.revision) throw conflict();
          return this.store(tx, item, row, this.now() + uploadTtl);
        });
      }
      const etag = await s3.put(item.objectKey, item.uploadId!, item.chunks.length + 1, bytes, signal);
      const next: Upload = {
        ...item,
        offset: offset + bytes.length,
        leaseUntil: undefined,
        pendingDigest: undefined,
        chunks: [...item.chunks, { size: bytes.length, digest, etag }],
        envelope: item.envelope ?? bytes.subarray(0, pmfHeaderBytes).toString("base64url"),
        state: offset + bytes.length === item.size ? "queued" : "uploading",
      };
      await this.metadata.transaction(async (tx) => {
        if ((await tx.get(row.id))?.revision !== row.revision) throw conflict();
        await this.store(tx, next, row, next.state === "queued" ? this.now() : this.now() + uploadTtl);
      });
      return view(next);
    } catch (error) {
      await this.metadata.transaction(async (tx) => {
        if ((await tx.get(row.id))?.revision === row.revision)
          await this.store(tx, { ...item, leaseUntil: undefined }, row, this.now() + uploadTtl);
      });
      throw error;
    }
  }

  async discard(owner: string, project: string, id: string) {
    return this.metadata.transaction(async (tx) => {
      const found = this.owned(await tx.get(rowId(id)), owner, project);
      if (!found) return false;
      await this.store(
        tx,
        { ...found.item, state: "cleanup", attempts: 0 },
        found.row,
        Math.max(this.now(), found.item.leaseUntil ?? 0),
      );
      return true;
    });
  }

  async retry(owner: string, project: string, id: string) {
    return this.metadata.transaction(async (tx) => {
      const found = this.owned(await tx.get(rowId(id)), owner, project);
      if (!found) throw notFound();
      if (found.item.state !== "failed" || !found.item.retryable) throw conflict();
      const next = {
        ...found.item,
        state: found.item.object ? ("checking" as const) : ("queued" as const),
        attempts: 0,
      };
      await this.store(tx, next, found.row, this.now());
      return view(next);
    });
  }

  private async claim(candidate: HarnessRecord) {
    return this.metadata.transaction(async (tx) => {
      const current = await tx.get(candidate.id);
      if (!current || current.revision !== candidate.revision || current.updatedAt > this.now()) return null;
      const item = upload(current);
      if (!["queued", "checking", "cleanup"].includes(item.state)) item.state = "cleanup";
      item.leaseUntil = this.now() + leaseMs;
      return { row: await this.store(tx, item, current, item.leaseUntil), item };
    });
  }

  private async step(item: Upload) {
    const signal = this.stopping.signal;
    if (item.state !== "cleanup") {
      try {
        await this.authorize(item.owner, item.project, "contribute");
      } catch (error) {
        if (["forbidden", "notFound"].includes(errorCode(error)) || [403, 404].includes(errorStatus(error, 503)))
          return { ...item, state: "cleanup" as const, attempts: 0 };
        throw error;
      }
    }
    const s3 = await this.multipart(item);
    if (item.state === "cleanup") {
      const uploads = item.uploadId ? [item.uploadId] : await s3.list(item.objectKey, signal);
      for (const uploadId of uploads) await s3.abort(item.objectKey, uploadId, signal);
      await s3.remove(item.objectKey, item.id, item.object?.versionId, signal);
      return null;
    }
    if (item.state === "queued") {
      const object = await s3.complete(
        item.objectKey,
        item.uploadId!,
        item.chunks.map((part) => part.etag),
        item.id,
        item.size,
        signal,
      );
      return { ...item, object, state: "checking" as const };
    }
    const part = item.chunks[item.checked];
    if (!part || !item.object) throw new ObjectStorageError("storageIntegrity");
    const bytes = await s3.read(
      item.objectKey,
      item.object,
      item.checked * s3MultipartPartBytes,
      part.size,
      part.digest,
      signal,
    );
    if (item.checked === 0 && !isPmf(bytes)) throw new ObjectStorageError("storageIntegrity");
    const complete = item.checked + 1 === item.chunks.length;
    const envelope = item.envelope ?? Buffer.from(bytes.subarray(0, pmfHeaderBytes)).toString("base64url");
    const version = pmfVersion(Buffer.from(envelope, "base64url"));
    const unsupported = complete && version === 1 && item.size > structuredMemoryPackageMaxBytes;
    return {
      ...item,
      checked: item.checked + 1,
      envelope,
      state: unsupported ? ("failed" as const) : complete ? ("awaiting-key" as const) : ("checking" as const),
      ...(unsupported ? { unsupported, retryable: false } : {}),
    };
  }

  async processPending() {
    const candidates = await this.metadata.list(kind, undefined, {
      limit: 4,
      oldestFirst: true,
      updatedThrough: this.now(),
    });
    for (const candidate of candidates) {
      if (this.stopping.signal.aborted) break;
      const claimed = await this.claim(candidate);
      if (!claimed) continue;
      const { row, item } = claimed;
      let next: Upload | null;
      let due: number;
      try {
        next = await this.step(item);
        if (next) next.attempts = 0;
        due = this.now() + (next?.state === "awaiting-key" || next?.state === "failed" ? uploadTtl : 0);
      } catch (error) {
        if (this.stopping.signal.aborted) {
          await this.metadata.transaction(async (tx) => {
            if ((await tx.get(row.id))?.revision === row.revision)
              await this.store(tx, { ...item, leaseUntil: undefined }, row, this.now());
          });
          return;
        }
        const retryable = !(error instanceof ObjectStorageError) || error.retryable;
        const attempts = item.attempts + 1;
        next = { ...item, attempts };
        due = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
        if (item.state !== "cleanup" && (!retryable || attempts >= maxAttempts)) {
          next.state = "failed";
          next.retryable = retryable || (error instanceof ObjectStorageError && error.code === "storageDenied");
          due = this.now() + uploadTtl;
        }
      }
      await this.metadata.transaction(async (tx) => {
        if ((await tx.get(row.id))?.revision !== row.revision) return;
        if (next) await this.store(tx, { ...next, leaseUntil: undefined }, row, due);
        else await tx.remove(row.id, row.revision);
      });
    }
  }

  async read(owner: string, project: string, id: string, key?: Buffer) {
    const found = this.owned(await this.metadata.read(rowId(id)), owner, project);
    if (!found) return null;
    const item = found.item;
    if (item.unsupported) throw new MemoryPackageError("projects.memoryPackageUnsupported");
    if (item.state !== "awaiting-key" || !item.object) throw conflict();
    if (!key || key.length !== 32) throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
    if (item.size > structuredMemoryPackageMaxBytes) throw new MemoryPackageError("projects.memoryPackageUnsupported");
    const s3 = await this.multipart(item);
    const encrypted = await s3.read(
      item.objectKey,
      item.object,
      0,
      item.size,
      item.chunks[0]!.digest,
      this.stopping.signal,
    );
    const manifest = await decodeMemoryPackage(
      item.size,
      async (offset, length) => Buffer.from(encrypted.subarray(offset, offset + length)),
      key,
    );
    if ((await this.metadata.read(found.row.id))?.revision !== found.row.revision) throw conflict();
    return {
      manifest,
      async assertCurrent(tx: HarnessMetadataTransaction) {
        if ((await tx.get(found.row.id))?.revision !== found.row.revision) throw conflict();
      },
    };
  }

  async withPackage<T>(
    owner: string,
    project: string,
    id: string,
    key: Buffer | undefined,
    work: (
      memory: unknown,
      materials?: OpenMemoryMaterials,
      assertCurrent?: (tx: HarnessMetadataTransaction) => Promise<void>,
    ) => Promise<T>,
  ) {
    const found = this.owned(await this.metadata.read(rowId(id)), owner, project);
    if (!found) return null;
    const { item, row } = found;
    if (!item.envelope || pmfVersion(Buffer.from(item.envelope, "base64url")) !== 2) {
      const legacy = await this.read(owner, project, id, key);
      return legacy ? { value: await work(legacy.manifest, undefined, legacy.assertCurrent) } : null;
    }
    if (item.state !== "awaiting-key" || !item.object) throw conflict();
    if (!key || key.length !== 32) throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
    const object = item.object;
    const s3 = await this.multipart(item);
    const assertCurrent = async (tx: HarnessMetadataTransaction) => {
      if ((await tx.get(row.id))?.revision !== row.revision) throw conflict();
    };
    let index = -1;
    let cache: Uint8Array | undefined;
    const read = async (offset: number, length: number) => {
      const bytes = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const position = offset + filled;
        const partNumber = Math.floor(position / s3MultipartPartBytes);
        if (index !== partNumber || !cache) {
          const part = item.chunks[partNumber];
          if (!part) throw conflict();
          cache = await s3.read(
            item.objectKey,
            object,
            partNumber * s3MultipartPartBytes,
            part.size,
            part.digest,
            this.stopping.signal,
          );
          index = partNumber;
        }
        const from = position - partNumber * s3MultipartPartBytes;
        const count = Math.min(cache.length - from, length - filled);
        if (count <= 0) throw conflict();
        bytes.set(cache.subarray(from, from + count), filled);
        filled += count;
      }
      return bytes;
    };
    const opened = await openMemoryMaterials(item.size, read, key);
    try {
      return { value: await work(opened.memory, opened, assertCurrent) };
    } finally {
      opened.close();
    }
  }

  start() {
    this.timer ??= setInterval(() => {
      if (!this.running)
        this.running = this.processPending()
          .catch(() => {})
          .finally(() => {
            this.running = undefined;
          });
    }, 1000);
    this.timer.unref();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.stopping.abort();
    await this.running;
  }
}
