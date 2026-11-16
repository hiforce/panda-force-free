import { crc32, inflateRaw } from "node:zlib";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { ZipPayload } from "./layout.js";

/** Decode only a previously bounded entry; symbolic links are never interpreted as regular files. */
export async function decodeZipPayload(
  bytes: Uint8Array,
  payload: ZipPayload,
  signal?: AbortSignal,
  allowRawLink = false,
) {
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  const { entry, start, end } = payload;
  if (entry.symlink && !allowRawLink) throw new SourceError("unsupportedSourceEntry");
  const packed = bytes.subarray(start, end),
    decoded =
      entry.method === 0
        ? packed
        : await new Promise<Uint8Array>((resolve, reject) => {
            inflateRaw(packed, { maxOutputLength: entry.expanded + 1 }, (error, value) => {
              if (error) reject(new SourceError("invalidArchive"));
              else resolve(value);
            });
          });
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  if (decoded.byteLength !== entry.expanded || crc32(decoded) !== entry.crc) throw new SourceError("invalidArchive");
  return decoded;
}
