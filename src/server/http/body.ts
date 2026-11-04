import type { IncomingMessage } from "node:http";

/** Client input failures keep their HTTP status across route error boundaries. */
export class RequestBodyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Read a bounded object payload; count bytes once rather than rescanning each prefix. */
export function readJsonBody(req: IncomingMessage, maxBytes = 256_000) {
  return new Promise<any>((resolvePromise, reject) => {
    let body = "",
      bytes = 0,
      tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new RequestBodyError("Bridge payload too large", 413));
      try {
        const value = JSON.parse(body || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value))
          return reject(new RequestBodyError("JSON body must be an object", 400));
        resolvePromise(value);
      } catch {
        reject(new RequestBodyError("Invalid JSON payload", 400));
      }
    });
  });
}
