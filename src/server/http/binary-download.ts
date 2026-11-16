import type { ServerResponse } from "node:http";
import { reportDiagnostic } from "../../shared/diagnostics.js";

/** Completion or disconnect releases the caller's byte lease; a slow client cannot retain it indefinitely. */
export function respondBinaryDownload(
  res: ServerResponse,
  value: { filename: string; bytes: Uint8Array },
  type: string,
): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) return resolve();
    let done = false;
    let offset = 0;
    const pump = () => {
        if (done) return;
        try {
          while (offset < value.bytes.length) {
            const end = Math.min(offset + 64 * 1024, value.bytes.length),
              ready = res.write(value.bytes.subarray(offset, end));
            offset = end;
            if (!ready) {
              res.once("drain", pump);
              return;
            }
          }
          res.end((error?: Error | null) => (error ? failure(error) : finish()));
        } catch (error) {
          failure(error);
        }
      },
      finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        res.off("close", finish);
        res.off("drain", pump);
        resolve();
      },
      failure = (error: unknown) => {
        if (done) return;
        reportDiagnostic("binary-download", error);
        res.destroy();
        finish();
      },
      timeout = setTimeout(() => {
        res.destroy();
        finish();
      }, 30000);
    timeout.unref();
    res.once("close", finish);
    res.once("error", failure);
    try {
      const name = encodeURIComponent(value.filename).replace(
        /[!'()*]/g,
        (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
      );
      const extension = /\.([a-z0-9]{1,10})$/i.exec(value.filename)?.[1]?.toLowerCase() || "bin";
      res.writeHead(200, {
        "content-type": type,
        "content-length": String(value.bytes.length),
        "content-disposition": `attachment; filename="export.${extension}"; filename*=UTF-8''${name}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      pump();
    } catch (error) {
      failure(error instanceof Error ? error : new Error("downloadUnavailable"));
    }
  });
}
