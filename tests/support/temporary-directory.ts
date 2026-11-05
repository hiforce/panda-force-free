import { mkdtempSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Small database fixtures keep real transactions without contending with container image snapshots. */
export function createTemporaryDirectory(prefix: string, { preferMemory = false } = {}): string {
  if (preferMemory && process.platform === "linux") {
    try {
      const available = statfsSync("/dev/shm");
      if (available.bavail * available.bsize >= 16 * 1024 * 1024) return mkdtempSync(join("/dev/shm", prefix));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!["ENOENT", "EACCES", "EPERM", "ENOSPC"].includes(String(code))) throw error;
    }
  }
  return mkdtempSync(join(tmpdir(), prefix));
}
