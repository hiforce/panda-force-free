import { open } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "./../../shared/errors.js";

// Read a bounded tail so a large CLI history cannot block the browser or server.
/** @param {{ maxBytes?: number, limit?: number, includeSession?: (id: string) => Promise<boolean> }} options */
export async function readComposerHistory(codexHome, options = {}) {
  const { maxBytes = 4 * 1024 * 1024, limit = 1000, includeSession } = options;
  let file;
  try {
    file = await open(join(codexHome, "history.jsonl"), "r");
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes),
      buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start) lines.shift(); // The first line may have been cut mid-record.
    const entries = [],
      decisions = new Map();
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        /* A malformed or still-being-written record is not a prompt. */
        continue;
      }
      if (!entry || typeof entry.text !== "string" || !entry.text) continue;
      if (includeSession) {
        const id = entry.session_id;
        if (typeof id !== "string" || !id) continue;
        if (!decisions.has(id)) decisions.set(id, await includeSession(id));
        if (!decisions.get(id)) continue;
      }
      entries.push({ text: entry.text });
    }
    return entries.slice(-limit);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  } finally {
    await file?.close();
  }
}
