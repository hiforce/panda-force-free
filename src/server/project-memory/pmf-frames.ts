import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from "node:crypto";
import { memoryPackageUploadMaxBytes } from "../../shared/project-memory/archive.js";
import {
  pmfFrameBytes,
  pmfHeaderBytes,
  pmfNonceBytes,
  pmfSegmentedMagic,
  pmfTagBytes,
  pmfVersion,
} from "../../shared/project-memory/pmf-envelope.js";
import { MemoryPackageError, memoryEnvelope } from "./pmf.js";

export type PackageRangeRead = (offset: number, length: number) => Promise<Buffer>;

const sealedFrameBytes = pmfFrameBytes + pmfTagBytes;
function frameParameters(header: Buffer, index: number, bytes: number, last: boolean) {
  const offset = pmfHeaderBytes - pmfNonceBytes;
  const nonce = Buffer.from(header.subarray(offset));
  nonce.writeUInt32BE(index, 8);
  const position = Buffer.alloc(9);
  position.writeUInt32BE(index, 0);
  position.writeUInt32BE(bytes, 4);
  position[8] = Number(last);
  return { nonce, aad: Buffer.concat([header, position]) };
}

export async function* sealMemoryFrames(recipient: KeyObject, source: AsyncIterable<Uint8Array>) {
  const key = randomBytes(32);
  try {
    const nonce = Buffer.concat([randomBytes(8), Buffer.alloc(4)]);
    const header = memoryEnvelope(recipient, key, pmfSegmentedMagic, nonce);
    yield header;
    const buffer = Buffer.alloc(pmfFrameBytes);
    let used = 0;
    let index = 0;
    const seal = (last: boolean) => {
      const { nonce, aad } = frameParameters(header, index, used, last);
      const end = pmfHeaderBytes + index * sealedFrameBytes + used + pmfTagBytes;
      if (end > memoryPackageUploadMaxBytes) throw new MemoryPackageError("projects.memoryPackageUnsupported");
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      return Buffer.concat([cipher.update(buffer.subarray(0, used)), cipher.final(), cipher.getAuthTag()]);
    };
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.length) {
        if (used === pmfFrameBytes) {
          yield seal(false);
          index++;
          used = 0;
        }
        const length = Math.min(chunk.length - offset, pmfFrameBytes - used);
        buffer.set(chunk.subarray(offset, offset + length), used);
        used += length;
        offset += length;
      }
    }
    if (!used) throw new MemoryPackageError("projects.memoryPackageInvalid");
    yield seal(true);
  } finally {
    key.fill(0);
  }
}

export async function openMemoryFrames(size: number, input: PackageRangeRead, key: Buffer) {
  if (!Number.isSafeInteger(size) || size > memoryPackageUploadMaxBytes || size <= pmfHeaderBytes + pmfTagBytes)
    throw new MemoryPackageError("projects.memoryPackageInvalid");
  const body = size - pmfHeaderBytes;
  const frames = Math.ceil(body / sealedFrameBytes);
  const clearSize = body - frames * pmfTagBytes;
  if (clearSize <= 0 || Math.ceil(clearSize / pmfFrameBytes) !== frames)
    throw new MemoryPackageError("projects.memoryPackageInvalid");

  const header = await input(0, pmfHeaderBytes);
  if (header.length !== pmfHeaderBytes || pmfVersion(header) !== 2 || header.readUInt32BE(pmfHeaderBytes - 4) !== 0)
    throw new MemoryPackageError("projects.memoryPackageInvalid");

  let cachedIndex = -1;
  let cached = Buffer.alloc(0);
  async function frame(index: number) {
    if (index === cachedIndex) return cached;
    const offset = index * pmfFrameBytes;
    const bytes = Math.min(pmfFrameBytes, clearSize - offset);
    const sealed = await input(pmfHeaderBytes + index * sealedFrameBytes, bytes + pmfTagBytes);
    if (sealed.length !== bytes + pmfTagBytes) throw new MemoryPackageError("projects.memoryPackageInvalid");
    const { nonce, aad } = frameParameters(header, index, bytes, index + 1 === frames);
    try {
      const cipher = createDecipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      cipher.setAuthTag(sealed.subarray(bytes));
      const clear = Buffer.concat([cipher.update(sealed.subarray(0, bytes)), cipher.final()]);
      cached.fill(0);
      cachedIndex = index;
      cached = clear;
      return clear;
    } catch {
      throw new MemoryPackageError("projects.memoryPackageUnlockFailed");
    }
  }

  return {
    size: clearSize,
    /** Range readers consume one authenticated frame at a time and never expose partial plaintext. */
    async read(offset: number, length: number) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset + length > clearSize ||
        length > 2 * pmfFrameBytes
      )
        throw new MemoryPackageError("projects.memoryPackageInvalid");
      const output = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const index = Math.floor((offset + filled) / pmfFrameBytes);
        const from = offset + filled - index * pmfFrameBytes;
        const data = await frame(index);
        const count = Math.min(data.length - from, length - filled);
        output.set(data.subarray(from, from + count), filled);
        filled += count;
      }
      return output;
    },
    close() {
      cached.fill(0);
      cachedIndex = -1;
    },
  };
}
