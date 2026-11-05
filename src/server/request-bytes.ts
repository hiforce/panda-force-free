import type { IncomingMessage } from "node:http";
export class RequestBodyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const verifiers = new WeakMap<IncomingMessage, (bytes: Buffer) => void>();
export function verifyRequestBody(request: IncomingMessage, verify: (bytes: Buffer) => void): void {
  verifiers.set(request, verify);
}
const buffers = new WeakMap<IncomingMessage, Promise<Buffer>>();
/** A verified internal request and its route share one bounded body read. */
export async function readRequestBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  let pending = buffers.get(request);
  if (!pending) {
    pending = (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0,
        tooLarge = Number(request.headers?.["content-length"]) > maxBytes;
      const stream: AsyncIterable<Uint8Array | string> = request;
      for await (const chunk of stream) {
        const data = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > maxBytes) tooLarge = true;
        if (!tooLarge) chunks.push(data);
      }
      if (tooLarge) throw new RequestBodyError("Bridge payload too large", 413);
      return Buffer.concat(chunks);
    })();
    buffers.set(request, pending);
  }
  const bytes = await pending;
  if (bytes.length > maxBytes) throw new RequestBodyError("Bridge payload too large", 413);
  verifiers.get(request)?.(bytes);
  return bytes;
}
