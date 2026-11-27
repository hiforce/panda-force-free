import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "../../shared/harness/contracts.js";
import {
  memoryPackageChunkBytes,
  memoryPackageExtension,
  memoryPackageUploadMaxBytes,
} from "../../shared/project-memory/archive.js";
import { isPmf, pmfMinimumBytes, pmfVersion } from "../../shared/project-memory/pmf-envelope.js";
import { openMemoryMaterials, type OpenMemoryMaterials } from "./pmf-materials.js";
import { decodeMemoryPackage, MemoryPackageError } from "./pmf.js";

const idleMs = 30 * 60_000;
interface Upload {
  owner: string;
  project: string;
  size: number;
  offset: number;
  expiry: number;
  busy: boolean;
  discarded?: boolean;
  version?: 1 | 2;
  directory?: string;
  file?: FileHandle;
  manifest?: unknown;
}

export function memoryPackageUploads() {
  const uploads = new Map<string, Upload>();
  let reserved = 0;
  let sweep: ReturnType<typeof setTimeout> | undefined;

  async function closeFile(upload: Upload) {
    const { file, directory } = upload;
    upload.file = undefined;
    upload.directory = undefined;
    if (file) reserved -= upload.size;
    try {
      await file?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  function remove(id: string, upload: Upload) {
    uploads.delete(id);
    return closeFile(upload);
  }

  function schedule() {
    if (sweep || !uploads.size) return;
    sweep = setTimeout(() => {
      sweep = undefined;
      for (const [id, upload] of uploads)
        if (!upload.busy && upload.expiry <= Date.now()) void remove(id, upload).catch(() => {});
      schedule();
    }, 60_000);
    sweep.unref();
  }

  function get(owner: string, project: string, id: string, allowBusy = false) {
    const upload = uploads.get(id);
    if (
      !upload ||
      upload.discarded ||
      upload.owner !== owner ||
      upload.project !== project ||
      upload.expiry <= Date.now()
    )
      throw new HarnessError("notFound", 404);
    if (upload.busy && !allowBusy) throw new HarnessError("busy", 409);
    upload.expiry = Date.now() + idleMs;
    return upload;
  }

  async function finish(id: string, upload: Upload) {
    upload.busy = false;
    if (upload.discarded) await remove(id, upload);
    else upload.expiry = Date.now() + idleMs;
  }

  const ranges = (file: FileHandle) => async (offset: number, length: number) => {
    const bytes = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const { bytesRead } = await file.read(bytes, received, length - received, offset + received);
      if (!bytesRead) throw new HarnessError("unavailable", 503);
      received += bytesRead;
    }
    return bytes;
  };

  return {
    async start(owner: string, project: string, name: unknown, size: unknown) {
      if (typeof name !== "string" || !name.toLowerCase().endsWith(memoryPackageExtension))
        throw new MemoryPackageError("projects.memoryPackageInvalid");
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < pmfMinimumBytes)
        throw new HarnessError("invalidInput");
      if (size > memoryPackageUploadMaxBytes) throw new HarnessError("contextTooLarge", 413);
      if (uploads.size >= 32 || reserved + size > 2 * memoryPackageUploadMaxBytes) throw new HarnessError("busy", 409);

      const id = randomUUID();
      const upload: Upload = { owner, project, size, offset: 0, expiry: Date.now() + idleMs, busy: true };
      uploads.set(id, upload);
      reserved += size;
      try {
        upload.directory = await mkdtemp(join(tmpdir(), "panda-memory-"));
        upload.file = await open(join(upload.directory, "package.pmf"), "wx+", 0o600);
        if (process.platform !== "win32") {
          await rm(upload.directory, { recursive: true });
          upload.directory = undefined;
        }
      } catch (error) {
        if (!upload.file) reserved -= size;
        await remove(id, upload);
        throw error;
      } finally {
        upload.busy = false;
      }
      schedule();
      return { id, offset: 0 };
    },
    status(owner: string, project: string, id: string) {
      return { id, offset: get(owner, project, id).offset };
    },
    async append(owner: string, project: string, id: string, offset: number, input: () => Promise<Buffer>) {
      const upload = get(owner, project, id);
      const expected = Math.min(memoryPackageChunkBytes, upload.size - upload.offset);
      const file = upload.file;
      if (!file || expected <= 0 || upload.offset !== offset) throw new HarnessError("conflict", 409);
      upload.busy = true;
      try {
        const bytes = await input();
        if (bytes.length !== expected) throw new HarnessError("invalidInput");
        if (!offset && !isPmf(bytes)) throw new MemoryPackageError("projects.memoryPackageInvalid");
        if (!offset) upload.version = pmfVersion(bytes);
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await file.write(bytes, written, bytes.length - written, offset + written);
          if (!bytesWritten) throw new HarnessError("unavailable", 503);
          written += bytesWritten;
        }
        upload.offset += written;
        return { id, offset: upload.offset };
      } finally {
        await finish(id, upload);
      }
    },
    async read(owner: string, project: string, id: string, key?: Buffer) {
      const upload = get(owner, project, id);
      if (upload.offset !== upload.size) throw new HarnessError("conflict", 409);
      if (!upload.file) return upload.manifest;
      if (!key || key.length !== 32) throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
      const file = upload.file;
      upload.busy = true;
      try {
        upload.manifest = await decodeMemoryPackage(upload.size, ranges(file), key);
        await closeFile(upload);
        return upload.manifest;
      } catch (error) {
        if (!(error instanceof MemoryPackageError) || error.messageId !== "projects.memoryPackageUnlockFailed")
          await remove(id, upload);
        throw error;
      } finally {
        await finish(id, upload);
      }
    },
    async withPackage<T>(
      owner: string,
      project: string,
      id: string,
      key: Buffer | undefined,
      work: (memory: unknown, materials?: OpenMemoryMaterials, assertCurrent?: () => void) => Promise<T>,
    ) {
      const upload = get(owner, project, id);
      if (upload.version !== 2) return work(await this.read(owner, project, id, key));
      const file = upload.file;
      if (!file || upload.offset !== upload.size) throw new HarnessError("conflict", 409);
      if (!key || key.length !== 32) throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
      upload.busy = true;
      let opened: OpenMemoryMaterials | undefined;
      const assertCurrent = () => {
        if (upload.discarded) throw new HarnessError("conflict", 409);
      };
      try {
        opened = await openMemoryMaterials(upload.size, ranges(file), key);
        assertCurrent();
        return await work(opened.memory, opened, assertCurrent);
      } finally {
        opened?.close();
        await finish(id, upload);
      }
    },
    async discard(owner: string, project: string, id: string) {
      const upload = get(owner, project, id, true);
      if (upload.busy) upload.discarded = true;
      else await remove(id, upload);
    },
  };
}
