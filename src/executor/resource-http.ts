import { BuildError } from "../shared/builds/errors.js";
import { RESOURCE_FRAME_MAX, RESOURCE_FRAME_TIMEOUT_MS, decodeResourceBuild } from "../shared/builds/resource-frame.js";

/** The handler owns one native admission until its bounded stream and verification have drained. */
export async function readExecutionBody(request: Request, maximum: number, sizeCode: string, timeoutMs = 30000) {
  const length = request.headers.get("Content-Length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await request.body?.cancel();
    throw new BuildError(sizeCode, 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new BuildError("missingInput");
  const chunks: Uint8Array[] = [];
  let total = 0,
    timedOut = false,
    cancellation: Promise<void> | null = null;
  const cancel = () => {
      cancellation ??= reader.cancel();
      // The finally block joins this operation; this handler only prevents an interim unhandled rejection.
      void cancellation.catch(() => {});
    },
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (request.signal.aborted) throw new BuildError("cancelled", 409);
    for (;;) {
      const { value, done } = await reader.read();
      if (request.signal.aborted) throw new BuildError("cancelled", 409);
      if (timedOut) throw new BuildError("buildInputTimedOut", 408);
      if (done) break;
      total += value.length;
      if (total > maximum) throw new BuildError(sizeCode, 413);
      chunks.push(new Uint8Array(value));
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    await (cancellation ?? reader.cancel());
    reader.releaseLock();
  }
}
export async function readResourceRequest(request: Request) {
  const input = await decodeResourceBuild(
    await readExecutionBody(request, RESOURCE_FRAME_MAX, "resourceBuildTooLarge", RESOURCE_FRAME_TIMEOUT_MS),
  );
  if (request.signal.aborted) throw new BuildError("cancelled", 409);
  return input;
}
