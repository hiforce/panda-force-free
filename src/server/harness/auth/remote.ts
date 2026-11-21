import { request } from "node:http";
import { HarnessError } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { HarnessCredentialSnapshot, HarnessCredentialSource, HarnessCredentialLease } from "./contracts.js";
import { decodeCredentialSnapshot, MAX_CREDENTIAL_BYTES } from "./snapshot.js";

export function brokerCredentialSource(socketPath: string): HarnessCredentialSource {
  return {
    snapshot: (rejectedGeneration) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(rejectedGeneration ? { rejectedGeneration } : {});
        const req = request(
          {
            socketPath,
            path: "/v1/credentials",
            method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_CREDENTIAL_BYTES) {
                req.destroy();
                reject(new HarnessError("invalidProtocol", 503));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", () => reject(new HarnessError("unavailable", 503)));
            res.on("end", () => {
              try {
                const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (res.statusCode !== 200)
                  throw new HarnessError(
                    isRecord(value) && value.error === "authentication" ? "authentication" : "unavailable",
                    503,
                  );
                resolve(decodeCredentialSnapshot(value));
              } catch (error) {
                reject(error instanceof HarnessError ? error : new HarnessError("invalidProtocol", 503));
              }
            });
          },
        );
        const timer = setTimeout(() => {
          req.destroy();
          reject(new HarnessError("timeout", 504));
        }, 30000);
        req.once("close", () => clearTimeout(timer));
        req.on("error", () => reject(new HarnessError("unavailable", 503)));
        req.end(body);
      }),
  };
}

/** Long-running agents receive renewed snapshots without granting them refresh credentials or replaying prompts. */
export async function credentialLease(
  source: HarnessCredentialSource,
  install: (snapshot: HarnessCredentialSnapshot) => Promise<void>,
  options: { now?: () => number; refreshBufferMs?: number; minDelayMs?: number } = {},
): Promise<HarnessCredentialLease> {
  let current: HarnessCredentialSnapshot | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  let pending: Promise<void> | null = null;
  const now = options.now ?? Date.now;
  const schedule = (delay: number) => {
    if (closed) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void update().catch(() => {});
      },
      Math.min(86400000, Math.max(options.minDelayMs ?? 30000, delay)),
    );
    timer.unref();
  };
  const update = (rejected = false): Promise<void> => {
    if (closed) return Promise.reject(new HarnessError("unavailable", 503));
    if (pending) return pending;
    if (timer) clearTimeout(timer);
    pending = (async () => {
      try {
        const next = await source.snapshot(rejected ? current?.generation : undefined);
        if (current && current.principal !== next.principal) throw new HarnessError("authentication", 503);
        if (closed) return;
        await install(next);
        current = next;
        if (next.expiresAt !== null) schedule(next.expiresAt - now() - (options.refreshBufferMs ?? 300000));
      } catch (error) {
        if (!closed) schedule(30000);
        throw error;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  try {
    await update();
  } catch (error) {
    closed = true;
    if (timer) clearTimeout(timer);
    throw error;
  }
  return {
    prepare: () => update(),
    rejected: () => update(true),
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await pending?.catch(() => {});
    },
  };
}
