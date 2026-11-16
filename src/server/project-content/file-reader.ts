import { ProjectContentError } from "./errors.js";

export interface ProjectFileReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export function boundedFileReadLength(size: number, offset: number, length: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 65536)
    throw new ProjectContentError("invalidFile");
  return Math.min(length, Math.max(0, size - offset));
}

/** Positioned reads may be short even before EOF, so consumers must not assume one read fills a range. */
export async function readProjectFileRange(file: ProjectFileReader, offset: number, length: number): Promise<Buffer> {
  const size = boundedFileReadLength(file.size, offset, length),
    result = Buffer.allocUnsafe(size);
  for (let position = 0; position < size;) {
    const bytes = await file.read(offset + position, size - position);
    if (!bytes.length || bytes.length > size - position) throw new ProjectContentError("invalidFile");
    bytes.copy(result, position);
    position += bytes.length;
  }
  return result;
}
