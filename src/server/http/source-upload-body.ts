import type { IncomingMessage } from "node:http";
import { SourceError } from "../../shared/packages/sources/contracts.js";
import type { SourceUploadBody } from "../packages/uploads/contracts.js";
import {
  readRequestBytes,
  requestBodyNeedsBuffering,
  releaseRequestBytes,
  RequestBodyError,
} from "../request-bytes.js";

/** Standalone requests stream directly; signed forwarding keeps its existing full-body verification contract. */
export function sourceUploadRequest(request: IncomingMessage, bytes: number, rejected?: () => void): SourceUploadBody {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new SourceError("invalidSource");
  const buffered = requestBodyNeedsBuffering(request),
    declared = request.headers["content-length"];
  let cancelled = false;
  const body: SourceUploadBody = {
    bufferedBytes: buffered ? bytes * 2 : 0,
    chunks: {
      async *[Symbol.asyncIterator]() {
        try {
          if (
            request.readableEncoding ||
            (declared !== undefined && (typeof declared !== "string" || !/^\d+$/.test(declared)))
          )
            throw new SourceError("invalidSource");
          if (declared !== undefined && Number(declared) !== bytes)
            throw new SourceError(Number(declared) > bytes ? "sourceTooLarge" : "sourceChanged");
          if (buffered) {
            const value = await readRequestBytes(request, bytes);
            for (let offset = 0; offset < value.length; offset += 65536) yield value.subarray(offset, offset + 65536);
          } else {
            for await (const chunk of request) {
              if (!(chunk instanceof Uint8Array)) throw new SourceError("invalidSource");
              yield chunk;
            }
          }
        } catch (error) {
          if (error instanceof RequestBodyError)
            throw new SourceError(error.status === 413 ? "sourceTooLarge" : "invalidSource");
          throw error instanceof SourceError ? error : new SourceError("invalidSource");
        } finally {
          releaseRequestBytes(request);
        }
      },
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      releaseRequestBytes(request);
      if (!request.readableEnded) {
        if (rejected) rejected();
        else request.destroy();
      }
    },
  };
  return body;
}
