import { createServer } from "node:http";
import { chmod } from "node:fs/promises";
import { HarnessError } from "../../../shared/harness/contracts.js";
import type { HarnessCredentialSource } from "./contracts.js";
import { isRecord } from "../../../shared/records.js";

/** The broker exposes only one installed account over a private Unix socket, never an application HTTP route. */
export async function serveCredentialBroker(socketPath: string, source: HarnessCredentialSource) {
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    if (active >= 64) {
      res.writeHead(503);
      res.end('{"error":"busy"}');
      return;
    }
    active++;
    try {
      if (req.url === "/health" && req.method === "GET") {
        res.end('{"ok":true}');
        return;
      }
      if (req.url !== "/v1/credentials" || req.method !== "POST") {
        res.writeHead(404);
        res.end('{"error":"notFound"}');
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 256) throw new HarnessError("invalidInput", 413);
        chunks.push(chunk);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new HarnessError("invalidInput");
      }
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => key !== "rejectedGeneration") ||
        (value.rejectedGeneration !== undefined &&
          (typeof value.rejectedGeneration !== "string" || !/^[a-f0-9]{64}$/.test(value.rejectedGeneration)))
      )
        throw new HarnessError("invalidInput");
      res.end(JSON.stringify(await source.snapshot(value.rejectedGeneration as string | undefined)));
    } catch (error) {
      const safe = error instanceof HarnessError ? error : new HarnessError("unavailable", 503);
      if (!res.headersSent) res.writeHead(safe.status);
      res.end(JSON.stringify({ error: safe.code }));
    } finally {
      active--;
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
