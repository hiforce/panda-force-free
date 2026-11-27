import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zip } from "fflate";
import { HarnessError } from "../../../shared/harness/contracts.js";
import { readSourceZip } from "../../packages/zip/read.js";

export const historyArchiveAge = 30 * 86_400_000;
export const historyArchiveInterval = 7 * 86_400_000;
const volumeLimit = 8 * 1024 * 1024;
const frameLimit = 1024 * 1024;
const indexLimit = 4 * 1024 * 1024;
const entryName = "history.jsonl";
const limits = {
  archiveBytes: volumeLimit + 64 * 1024,
  fileBytes: volumeLimit,
  totalBytes: volumeLimit,
  entries: 1,
  files: 1,
};
const marker = (path: string) => path + ".archives";
type Position = { inode: string; base: number; firstSeq: number };
type Volume = { name: string; from: number; to: number; sha256: string };
interface ArchiveIndex {
  before: Position;
  active: Position;
  volumes: Volume[];
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const corrupt = () => new HarnessError("historyCorrupt", 503);
const noFile = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const absolute = (file: FileHandle) => file.stat({ bigint: true }).then(({ ino }) => ino.toString());

async function exact(file: FileHandle, offset: number, bytes: Buffer) {
  let done = 0;
  while (done < bytes.length) {
    const { bytesRead } = await file.read(bytes, done, bytes.length - done, offset + done);
    if (!bytesRead) throw corrupt();
    done += bytesRead;
  }
  return bytes;
}

async function loadIndex(path: string): Promise<ArchiveIndex | null> {
  let file: FileHandle;
  try {
    file = await open(marker(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (noFile(error)) return null;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size > indexLimit) throw corrupt();
    const parsed: ArchiveIndex = JSON.parse((await exact(file, 0, Buffer.alloc(size))).toString("utf8"));
    for (const pointer of [parsed.before, parsed.active]) {
      if (
        !/^\d+$/u.test(pointer.inode) ||
        !Number.isSafeInteger(pointer.base) ||
        pointer.base < 0 ||
        !Number.isSafeInteger(pointer.firstSeq) ||
        pointer.firstSeq < 1
      )
        throw corrupt();
    }
    if (
      parsed.active.base <= parsed.before.base ||
      parsed.active.inode === parsed.before.inode ||
      parsed.active.firstSeq <= parsed.before.firstSeq
    )
      throw corrupt();
    let last = 0;
    for (const { name, from, to, sha256 } of parsed.volumes) {
      if (
        !/^history_\d{14}_[a-f0-9]{16}_[a-f0-9]{8}\.zip$/u.test(name) ||
        from !== last ||
        !Number.isSafeInteger(to) ||
        to <= from ||
        to - from > volumeLimit ||
        !/^[a-f0-9]{64}$/u.test(sha256)
      )
        throw corrupt();
      last = to;
    }
    if (last !== parsed.active.base) throw corrupt();
    return parsed;
  } finally {
    await file.close();
  }
}

async function archiveBytes(path: string, volume: Volume) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    if (size > limits.archiveBytes) throw corrupt();
    const archive = await exact(file, 0, Buffer.alloc(size));
    if (hash(archive) !== volume.sha256) throw corrupt();
    const tree = await readSourceZip(archive, limits);
    const bytes = tree.read(entryName);
    if (!bytes || bytes.length !== volume.to - volume.from) throw corrupt();
    return Buffer.from(bytes);
  } finally {
    await file.close();
  }
}

async function restoredPosition(file: FileHandle, index: ArchiveIndex) {
  const { size } = await file.stat();
  if (!size) return index.active;
  let prefix = await exact(file, 0, Buffer.alloc(Math.min(size, 4096)));
  let end = prefix.indexOf(10);
  if (end < 0 && size > prefix.length) {
    prefix = await exact(file, 0, Buffer.alloc(Math.min(size, frameLimit + 1)));
    end = prefix.indexOf(10);
  }
  if (end < 1) throw corrupt();
  const { event } = JSON.parse(prefix.toString("utf8", 0, end));
  if (event?.seq === index.active.firstSeq) return index.active;
  if (event?.seq === index.before.firstSeq) return index.before;
  throw corrupt();
}

export async function openHistoryFile(path: string, write = false) {
  // An open descriptor remains readable across a rotation. The durable index identifies both inodes during cutover.
  const file = await open(
    path,
    (write ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const inode = await absolute(file),
      index = await loadIndex(path);
    const position = index ? await restoredPosition(file, index) : undefined;
    const base = position?.base ?? 0;
    const volumes = index?.volumes.filter((volume) => volume.to <= base) ?? [];
    let cached: { volume: Volume; bytes: Buffer } | undefined;
    return {
      file,
      inode,
      base,
      volumes,
      close: () => file.close(),
      size: async () => base + (await file.stat()).size,
      read: async (target: Buffer, offset: number, length: number, position: number) => {
        if (position >= base) return file.read(target, offset, length, position - base);
        const volume = volumes.find(({ from, to }) => position >= from && position < to);
        if (!volume) throw corrupt();
        if (cached?.volume !== volume)
          cached = { volume, bytes: await archiveBytes(join(dirname(path), volume.name), volume) };
        const start = position - volume.from;
        const bytesRead = Math.min(length, volume.to - position);
        cached.bytes.copy(target, offset, start, start + bytesRead);
        return { bytesRead };
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

type Reader = Awaited<ReturnType<typeof openHistoryFile>>;
async function writeAll(file: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new HarnessError("unavailable", 503);
    offset += bytesWritten;
  }
}
async function durable(path: string, bytes: Uint8Array) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(file, bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function prepareHistoryRotation(
  path: string,
  committed: number,
  now: number,
  inspect: (line: string) => { at: number; seq: number },
  signal: AbortSignal,
) {
  if (!committed || signal.aborted) return null;
  const original = await openHistoryFile(path);
  const token = randomUUID(),
    suffix = token.slice(0, 8);
  const staging = (label: string) => join(dirname(path), `.history-${token}-${label}`);
  const stagedVolumes: Array<Volume & { staged: string }> = [];
  const tail = staging("tail");
  const stagedIndex = staging("index");
  const removeStaging = () =>
    Promise.allSettled(
      [tail, stagedIndex, ...stagedVolumes.map(({ staged }) => staged)].map((name) => rm(name, { force: true })),
    );
  let successful = false;
  try {
    if ((await original.size()) < committed) throw corrupt();
    let next = original.base,
      firstSeq = 0,
      lastSeq = 0;
    const stamp = new Date(now).toISOString().slice(0, 19).replace(/\D/gu, "");
    while (next < committed) {
      signal.throwIfAborted();
      const input = await exact(
        original.file,
        next - original.base,
        Buffer.alloc(Math.min(volumeLimit, committed - next)),
      );
      let position = 0;
      while (position < input.length) {
        const end = input.indexOf(10, position);
        if (end < 0) {
          if (input.length - position >= frameLimit || next + input.length === committed) throw corrupt();
          break;
        }
        const frame = inspect(input.toString("utf8", position, end));
        if (frame.at >= now - historyArchiveAge) break;
        firstSeq ||= frame.seq;
        if (lastSeq && frame.seq !== lastSeq + 1) throw corrupt();
        lastSeq = frame.seq;
        position = end + 1;
      }
      if (!position) break;
      const raw = input.subarray(0, position);
      const packed = await new Promise<Uint8Array>((resolve, reject) =>
        zip({ [entryName]: raw }, { level: 6 }, (error, bytes) => (error ? reject(error) : resolve(bytes))),
      );
      const name = `history_${stamp}_${next.toString(16).padStart(16, "0")}_${suffix}.zip`;
      const volume = {
        name,
        from: next,
        to: next + position,
        sha256: hash(packed),
        staged: staging(stagedVolumes.length.toString()),
      };
      stagedVolumes.push(volume);
      await durable(volume.staged, packed);
      if (hash(await archiveBytes(volume.staged, volume)) !== hash(raw)) throw corrupt();
      next = volume.to;
      // A newline still within this buffer starts the first retained frame.
      if (input.indexOf(10, position) >= 0) break;
    }
    if (!stagedVolumes.length) return null;
    const file = await open(
      tail,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for (let at = next; at < committed;) {
        signal.throwIfAborted();
        const chunk = await exact(
          original.file,
          at - original.base,
          Buffer.alloc(Math.min(1024 * 1024, committed - at)),
        );
        await writeAll(file, chunk);
        at += chunk.length;
      }
      await file.sync();
      const index: ArchiveIndex = {
        before: { inode: original.inode, base: original.base, firstSeq },
        active: { inode: await absolute(file), base: next, firstSeq: lastSeq + 1 },
        volumes: [...original.volumes, ...stagedVolumes.map(({ staged: _staged, ...volume }) => volume)],
      };
      const indexBytes = Buffer.from(JSON.stringify(index));
      if (indexBytes.length > indexLimit) throw corrupt();
      await durable(stagedIndex, indexBytes);
    } finally {
      await file.close();
    }
    successful = true;
    return {
      async publish() {
        const live: Reader = await openHistoryFile(path);
        try {
          if (live.inode !== original.inode || live.base !== original.base || (await live.size()) < committed)
            return false;
        } finally {
          await live.close();
        }
        for (const { staged, name } of stagedVolumes) await rename(staged, join(dirname(path), name));
        await syncDirectory(path);
        await rename(stagedIndex, marker(path));
        await syncDirectory(path);
        await rename(tail, path);
        await syncDirectory(path);
        return true;
      },
      discard: removeStaging,
    };
  } finally {
    await original.close();
    if (!successful) await removeStaging();
  }
}
