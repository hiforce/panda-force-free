import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { HarnessError } from "../../../shared/harness/contracts.js";
const SIZE = 64;
export interface HistoryTimeBlock {
  start: number;
  end: number;
  firstSeq: number;
  lastSeq: number;
  from: number;
  to: number;
}
function encode(block: HistoryTimeBlock) {
  const bytes = Buffer.alloc(SIZE);
  [block.start, block.end, block.firstSeq, block.lastSeq, block.from, block.to].forEach((value, index) =>
    bytes.writeDoubleLE(value, index * 8),
  );
  createHash("sha256").update(bytes.subarray(0, 48)).digest().copy(bytes, 48, 0, 16);
  return bytes;
}
function decode(bytes: Buffer): HistoryTimeBlock {
  if (
    bytes.length !== SIZE ||
    !createHash("sha256").update(bytes.subarray(0, 48)).digest().subarray(0, 16).equals(bytes.subarray(48))
  )
    throw new HarnessError("historyCorrupt", 503);
  const [start, end, firstSeq, lastSeq, from, to] = Array.from({ length: 6 }, (_, index) =>
    bytes.readDoubleLE(index * 8),
  );
  if (
    ![start, end, firstSeq, lastSeq, from, to].every((value) => Number.isSafeInteger(value) && value! >= 0) ||
    end! <= start! ||
    lastSeq! < firstSeq!
  )
    throw new HarnessError("historyCorrupt", 503);
  return { start: start!, end: end!, firstSeq: firstSeq!, lastSeq: lastSeq!, from: from!, to: to! };
}
async function read(file: FileHandle, position: number) {
  const bytes = Buffer.alloc(SIZE);
  const result = await file.read(bytes, 0, SIZE, position);
  if (result.bytesRead !== SIZE) throw new HarnessError("historyCorrupt", 503);
  return decode(bytes);
}
/** A small derived index bounds time-range retrieval without putting transcript bodies in the database. */
export class HarnessTimeIndex {
  constructor(private readonly path: string) {}
  async append(committed: number, block: HistoryTimeBlock) {
    const file = await open(this.path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      let end = Math.floor((await file.stat()).size / SIZE) * SIZE;
      // Roll back index entries belonging to a data write whose metadata transaction never committed.
      while (end > 0 && (await read(file, end - SIZE)).end > committed) end -= SIZE;
      await file.truncate(end);
      const previous = end ? await read(file, end - SIZE) : null;
      if ((previous?.end ?? 0) !== committed || block.start !== committed)
        throw new HarnessError("historyCorrupt", 503);
      await file.write(encode(block), 0, SIZE, end);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async matching(committed: number, from: number, to: number, cursor = 0, maximumBlocks = 256) {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor % SIZE ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from > to
    )
      throw new HarnessError("invalidInput");
    let file: FileHandle;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      if (!committed) return { blocks: [], next: null };
      throw new HarnessError("historyCorrupt", 503);
    }
    try {
      const size = Math.floor((await file.stat()).size / SIZE) * SIZE,
        blocks: Array<HistoryTimeBlock & { indexOffset: number }> = [];
      if (cursor > size) throw new HarnessError("invalidInput");
      let offset = cursor,
        scanned = 0;
      while (offset < size && scanned++ < 16384 && blocks.length < maximumBlocks) {
        const block = await read(file, offset),
          indexOffset = offset;
        offset += SIZE;
        if (block.end > committed) return { blocks, next: null };
        if (block.to >= from && block.from <= to) blocks.push({ ...block, indexOffset });
      }
      return { blocks, next: offset < size ? offset : null };
    } finally {
      await file.close();
    }
  }
}
export const historyIndexRecordBytes = SIZE;
