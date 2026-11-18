import { stripSessionSkillContext } from "../../shared/session-skills.js";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { errorCode } from "./../../shared/errors.js";
import { stripAttachmentWorkspaceContext } from "../../shared/attachment-workspace.js";

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
      const text = stripSessionSkillContext(stripAttachmentWorkspaceContext(entry.text));
      if (text) entries.push({ text });
    }
    return entries.slice(-limit);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  } finally {
    await file?.close();
  }
}

/** Read intact recent prompts only when requested, continuing backwards through a stable file cursor.
 * @param {string} codexHome
 * @param {{cursor?: string, limit?: number, maxBytes?: number, byteBudget?: number, includeSession?: (id: string) => Promise<boolean>}} options
 */
export async function readComposerHistoryPage(codexHome, options = {}) {
  const { cursor, limit = 20, maxBytes = 4 * 1024 * 1024, byteBudget = 32 * 1024, includeSession } = options;
  const invalid = () => Object.assign(new Error("Invalid input history cursor"), { code: "composer_history_cursor" });
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(byteBudget) ||
    byteBudget < 1
  )
    throw invalid();
  let file;
  try {
    file = await open(join(codexHome, "history.jsonl"), "r");
    const stat = await file.stat();
    const identity = createHash("sha256")
      .update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`)
      .digest("hex")
      .slice(0, 24);
    const anchor = async (end) => {
      const buffer = Buffer.alloc(Math.min(128, end));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, end - buffer.length);
      return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex").slice(0, 24);
    };
    let end = stat.size;
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
      let value;
      try {
        value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        throw invalid();
      }
      if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value[0] !== 1 ||
        value[1] !== identity ||
        !Number.isSafeInteger(value[2]) ||
        value[2] < 0 ||
        value[2] > stat.size ||
        value[3] !== (await anchor(value[2]))
      )
        throw invalid();
      end = value[2];
    }
    if (!end) return { entries: [], nextCursor: null };
    const start = Math.max(0, end - maxBytes),
      buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const entries = [],
      decisions = new Map();
    let position = read,
      consumed = end,
      bytes = 0;
    while (position > 0) {
      if (buffer[position - 1] === 10) position--;
      if (!position) {
        consumed = start;
        break;
      }
      const previous = buffer.lastIndexOf(10, position - 1),
        begin = previous + 1;
      // Re-read the incomplete oldest line in the next bounded window instead of dropping it.
      if (start && previous < 0) {
        consumed = start + position;
        break;
      }
      let value;
      try {
        value = JSON.parse(buffer.subarray(begin, position).toString("utf8"));
      } catch {}
      let text = "";
      if (value && typeof value.text === "string" && value.text) {
        let permitted = true;
        if (includeSession) {
          const id = value.session_id;
          permitted = typeof id === "string" && !!id;
          if (permitted) {
            if (!decisions.has(id)) decisions.set(id, await includeSession(id));
            permitted = decisions.get(id);
          }
        }
        if (permitted) text = stripSessionSkillContext(stripAttachmentWorkspaceContext(value.text));
      }
      if (text) {
        const item = { text },
          size = Buffer.byteLength(JSON.stringify(item)) + 1;
        // A single requested prompt remains intact even when it exceeds the normal page target.
        if (entries.length && bytes + size > byteBudget) break;
        entries.unshift(item);
        bytes += size;
      }
      consumed = start + begin;
      position = previous;
      if (entries.length >= limit) break;
    }
    if (consumed === end && !entries.length)
      throw Object.assign(new Error("Input history record exceeds the read window"), {
        code: "composer_history_unavailable",
      });
    const nextCursor =
      consumed > 0
        ? Buffer.from(JSON.stringify([1, identity, consumed, await anchor(consumed)])).toString("base64url")
        : null;
    return { entries, nextCursor };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      if (cursor !== undefined) throw invalid();
      return { entries: [], nextCursor: null };
    }
    throw error;
  } finally {
    await file?.close();
  }
}
