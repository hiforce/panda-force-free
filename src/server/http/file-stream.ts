import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

/** Stream an already authorized canonical path without following a replaced final symlink. */
export async function streamResponseFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  headers: Record<string, string>,
  revalidate = false,
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error("File unavailable");
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (revalidate) {
      headers = { ...headers, etag };
      if (
        String(req.headers["if-none-match"] || "")
          .split(/\s*,\s*/)
          .some((value) => value === "*" || value.replace(/^W\//, "") === etag.replace(/^W\//, ""))
      ) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }
    res.writeHead(200, { ...headers, "content-length": String(stat.size) });
    if (req.method === "HEAD") res.end();
    else await pipeline(file.createReadStream({ autoClose: false }), res);
  } catch (error) {
    if (!res.headersSent) throw error;
    res.destroy();
  } finally {
    await file.close();
  }
}
