import { openHistoryFile, prepareHistoryRotation } from "./history-archive.js";
import { HarnessTimeIndex } from "./time-index.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { HarnessError, type HarnessMessage, type HarnessHistoryEvent } from "../../../shared/harness/contracts.js";
import type { HarnessHistory } from "../ports.js";

const MAX_FRAME = 1024 * 1024;
const MAX_READ = 128 * 1024 * 1024;
const SCAN_CHUNK = 32 * 1024;
/** Private application-owned transcripts are separated by owner and conversation, never native engine paths. */
export class JsonlHarnessHistory implements HarnessHistory {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}
  private async path(owner: string, id: string) {
    if (!owner || owner.length > 512 || !/^[a-f0-9-]{36}$/.test(id)) throw new HarnessError("invalidInput");
    const namespace = createHash("sha256").update(owner).digest("hex"),
      base = resolve(this.root);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const directory = join(base, namespace, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const actual = await realpath(directory),
      distance = relative(await realpath(base), actual);
    if (isAbsolute(distance) || distance.startsWith("..")) throw new HarnessError("forbidden", 403);
    return join(actual, "history.jsonl");
  }
  /** Reads a bounded complete-frame tail. Huge transcripts never need to be loaded to construct a handoff. */
  async window(
    owner: string,
    id: string,
    committed: number,
    options: { beforeBytes?: number; maxBytes?: number } = {},
  ) {
    const end = options.beforeBytes ?? committed,
      budget = Math.min(8 * 1024 * 1024, Math.max(MAX_FRAME + 1, options.maxBytes ?? 2 * 1024 * 1024));
    if (!Number.isSafeInteger(committed) || committed < 0 || !Number.isSafeInteger(end) || end < 0 || end > committed)
      throw new HarnessError("invalidInput");
    if (!end) return { events: [], startBytes: 0, truncated: false };
    const file = await openHistoryFile(await this.path(owner, id));
    try {
      if ((await file.size()) < committed) throw new HarnessError("historyCorrupt", 503);
      let start = Math.max(0, end - budget);
      const body = Buffer.alloc(end - start);
      let offset = 0;
      while (offset < body.length) {
        const result = await file.read(body, offset, body.length - offset, start + offset);
        if (!result.bytesRead) throw new HarnessError("historyCorrupt", 503);
        offset += result.bytesRead;
      }
      if (body.at(-1) !== 10) throw new HarnessError("historyCorrupt", 503);
      let head = 0;
      if (start) {
        head = body.indexOf(10) + 1;
        if (!head) throw new HarnessError("historyCorrupt", 503);
        start += head;
      }
      let previous: number | null = null;
      const events: HarnessHistoryEvent[] = body
        .subarray(head)
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            if (Buffer.byteLength(line) > MAX_FRAME) throw Error();
            const frame = historyFrame(line);
            if (!Number.isSafeInteger(frame.event.seq) || (previous !== null && frame.event.seq !== previous + 1))
              throw Error();
            previous = frame.event.seq;
            return frame.event;
          } catch {
            throw new HarnessError("historyCorrupt", 503);
          }
        });
      return { events, startBytes: start, truncated: start > 0 };
    } finally {
      await file.close();
    }
  }
  async scanUserMessages(owner: string, id: string, committed: number, afterBytes: number) {
    if (
      !Number.isSafeInteger(committed) ||
      !Number.isSafeInteger(afterBytes) ||
      afterBytes < 0 ||
      afterBytes > committed
    )
      throw new HarnessError("invalidInput");
    const messages: Array<{ message: HarnessMessage; throughBytes: number }> = [];
    if (afterBytes === committed) return { messages, nextBytes: committed };
    const file = await openHistoryFile(await this.path(owner, id));
    try {
      const start = Math.max(0, afterBytes - 1);
      const prefix = afterBytes - start;
      const budget = Math.min(MAX_FRAME + 1, committed - afterBytes) + prefix;
      const bytes = Buffer.allocUnsafe(budget);
      if ((await file.size()) < committed) throw new HarnessError("historyCorrupt", 503);
      if (start + budget === committed) {
        const tail = await file.read(bytes, budget - 1, 1, committed - 1);
        if (tail.bytesRead !== 1 || bytes[budget - 1] !== 10) throw new HarnessError("historyCorrupt", 503);
      }
      let cursor = prefix;
      let searchAt = cursor;
      let filled = 0;
      let previous: number | undefined;
      let count = 0;
      while (count < 256 && messages.length < 8 && (searchAt < filled || filled < budget)) {
        // Small messages usually fill the page before the maximum frame-sized read is needed.
        if (searchAt >= filled) {
          const end = Math.min(budget, Math.max(SCAN_CHUNK, filled * 2));
          while (filled < end) {
            const result = await file.read(bytes, filled, end - filled, start + filled);
            if (!result.bytesRead) throw new HarnessError("historyCorrupt", 503);
            filled += result.bytesRead;
          }
          if (prefix && bytes[0] !== 10) throw new HarnessError("historyCorrupt", 503);
        }
        const newline = bytes.subarray(0, filled).indexOf(10, searchAt);
        if (newline < 0) {
          searchAt = filled;
          continue;
        }
        if (newline === cursor || newline - cursor > MAX_FRAME) throw new HarnessError("historyCorrupt", 503);
        const { event } = historyFrame(bytes.toString("utf8", cursor, newline));
        if (!Number.isSafeInteger(event.seq) || (previous !== undefined && event.seq !== previous + 1))
          throw new HarnessError("historyCorrupt", 503);
        previous = event.seq;
        count++;
        cursor = newline + 1;
        searchAt = cursor;
        if (event.type === "message" && event.message.role === "user")
          messages.push({ message: event.message, throughBytes: start + cursor });
      }
      const nextBytes = start + cursor;
      if (nextBytes <= afterBytes) throw new HarnessError("historyCorrupt", 503);
      return { messages, nextBytes };
    } finally {
      await file.close();
    }
  }
  async messageAt(
    owner: string,
    id: string,
    committed: number,
    { messageId, recordedAt, throughBytes }: { messageId: string; recordedAt: number; throughBytes?: number },
  ) {
    const readAt = async (beforeBytes: number) => {
      const { events } = await this.window(owner, id, committed, { beforeBytes, maxBytes: MAX_FRAME + 1 });
      const event = events.find((item) => item.type === "message" && item.message.id === messageId);
      return event?.type === "message" ? event.message : null;
    };
    const recent = await readAt(throughBytes ?? committed);
    if (recent || throughBytes !== undefined) return recent;
    // Evidence learned before byte locations were stored can use the original submission time.
    const index = new HarnessTimeIndex((await this.path(owner, id)) + ".time-index");
    const { blocks } = await index.matching(committed, recordedAt - 60_000, recordedAt + 60_000, 0, 64);
    const distance = ({ from, to }: { from: number; to: number }) => Math.max(from - recordedAt, recordedAt - to, 0);
    blocks.sort((a, b) => distance(a) - distance(b));
    for (const { end } of blocks.slice(0, 10)) {
      if (end === committed) continue;
      const message = await readAt(end);
      if (message) return message;
    }
    return null;
  }
  async prepareRotation(owner: string, id: string, committed: number, signal: AbortSignal) {
    const now = this.now();
    return prepareHistoryRotation(
      await this.path(owner, id),
      committed,
      now,
      (line) => {
        const { retainedAtMs, event } = historyFrame(line);
        return { at: retainedAtMs, seq: event.seq };
      },
      signal,
    );
  }
  async reference(owner: string, id: string, committedBytes: number) {
    const path = await this.path(owner, id);
    return {
      uri: `pandaforce-history://${id}`,
      path,
      indexPath: path + ".time-index",
      committedBytes,
      format: "PandaForce JSONL v2",
      timestampField: "timestamp",
      sequenceField: "event.seq",
      readOnly: true as const,
    };
  }
  async queryTime(
    owner: string,
    id: string,
    committed: number,
    input: import("../../../shared/harness/contracts.js").HarnessHistoryQuery,
  ) {
    return queryHarnessHistoryFile(await this.path(owner, id), committed, input);
  }
  async read(owner: string, id: string, bytes: number): Promise<HarnessHistoryEvent[]> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_READ) throw new HarnessError("historyCorrupt", 503);
    if (!bytes) return [];
    const file = await openHistoryFile(await this.path(owner, id));
    try {
      if ((await file.size()) < bytes) throw new HarnessError("historyCorrupt", 503);
      const body = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < bytes) {
        const r = await file.read(body, offset, bytes - offset, offset);
        if (!r.bytesRead) throw new HarnessError("historyCorrupt", 503);
        offset += r.bytesRead;
      }
      if (body.at(-1) !== 10) throw new HarnessError("historyCorrupt", 503);
      let sequence = 0;
      return body
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          if (Buffer.byteLength(line) > MAX_FRAME) throw new HarnessError("historyCorrupt", 503);
          try {
            const frame = historyFrame(line);
            if (frame.event.seq !== ++sequence) throw Error();
            return frame.event;
          } catch {
            throw new HarnessError("historyCorrupt", 503);
          }
        });
    } finally {
      await file.close();
    }
  }
  /** Caller holds the metadata transaction and execution fence until the returned offset is committed. */
  async append(owner: string, id: string, bytes: number, events: readonly HarnessHistoryEvent[]) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER - MAX_FRAME)
      throw new HarnessError("historyCorrupt", 503);
    const recordedAtMs = this.now(),
      recordedAt = new Date(recordedAtMs).toISOString();
    const times: number[] = [];
    const payload = events
      .map((event) => {
        const value = JSON.stringify(event);
        if (Buffer.byteLength(value) > MAX_FRAME - 256) throw new HarnessError("invalidInput");
        const timestampMs =
          event.type === "message" && event.message.sourceTimestampKnown !== false
            ? event.message.createdAt
            : recordedAtMs;
        const timestamp = new Date(timestampMs).toISOString();
        times.push(timestampMs);
        return (
          JSON.stringify({
            schema: 2,
            recordedAt,
            recordedAtMs,
            timestamp,
            timestampMs,
            event,
            sha256: createHash("sha256")
              .update(JSON.stringify({ timestamp, timestampMs, recordedAt, recordedAtMs, event }))
              .digest("hex"),
          }) + "\n"
        );
      })
      .join("");
    const body = Buffer.from(payload);

    const path = await this.path(owner, id),
      live = await openHistoryFile(path, true);
    const { file, base } = live;
    try {
      const size = await live.size();
      if (size < bytes) throw new HarnessError("historyCorrupt", 503);
      // Bytes beyond the committed metadata offset belong to an interrupted transaction.
      if (size > bytes) await file.truncate(bytes - base);
      let written = 0;
      while (written < body.length) {
        const result = await file.write(body, written, body.length - written, bytes - base + written);
        if (!result.bytesWritten) throw new HarnessError("unavailable", 503);
        written += result.bytesWritten;
      }
      await file.sync();
      if (events.length)
        await new HarnessTimeIndex(path + ".time-index").append(bytes, {
          start: bytes,
          end: bytes + body.length,
          firstSeq: events[0]!.seq,
          lastSeq: events.at(-1)!.seq,
          from: Math.min(...times),
          to: Math.max(...times),
        });
      const directory = await open(resolve(path, ".."), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return bytes + body.length;
    } finally {
      await file.close();
    }
  }
}

export function historyFrame(line: string): { event: HarnessHistoryEvent; timestampMs: number; retainedAtMs: number } {
  try {
    if (Buffer.byteLength(line) > MAX_FRAME) throw Error();
    const frame = JSON.parse(line) as {
      schema: number;
      event: HarnessHistoryEvent;
      timestamp?: string;
      timestampMs?: number;
      recordedAt?: string;
      recordedAtMs?: number;
      sha256: string;
    };
    const source =
      frame.schema === 2
        ? {
            timestamp: frame.timestamp,
            timestampMs: frame.timestampMs,
            ...(frame.recordedAt !== undefined
              ? { recordedAt: frame.recordedAt, recordedAtMs: frame.recordedAtMs }
              : {}),
            event: frame.event,
          }
        : frame.event;
    if (
      ![1, 2].includes(frame.schema) ||
      createHash("sha256").update(JSON.stringify(source)).digest("hex") !== frame.sha256
    )
      throw Error();
    const timestampMs =
      frame.schema === 2 ? frame.timestampMs : frame.event.type === "message" ? frame.event.message.createdAt : 0;
    if (
      !Number.isSafeInteger(timestampMs) ||
      timestampMs! < 0 ||
      (frame.schema === 2 && new Date(timestampMs!).toISOString() !== frame.timestamp) ||
      (frame.recordedAt !== undefined &&
        (!Number.isSafeInteger(frame.recordedAtMs) || new Date(frame.recordedAtMs!).toISOString() !== frame.recordedAt))
    )
      throw Error();
    return {
      event: frame.event,
      timestampMs: timestampMs!,
      // Pre-timestamp events remain together with the most recent known frame during rotation.
      retainedAtMs: frame.recordedAtMs ?? timestampMs!,
    };
  } catch {
    throw new HarnessError("historyCorrupt", 503);
  }
}

export async function queryHarnessHistoryFile(
  path: string,
  committed: number,
  input: import("../../../shared/harness/contracts.js").HarnessHistoryQuery,
): Promise<import("../../../shared/harness/contracts.js").HarnessHistoryPage> {
  if (
    !Number.isSafeInteger(committed) ||
    committed < 0 ||
    (input.query?.length ?? 0) > 200 ||
    !Number.isFinite(input.from) ||
    !Number.isFinite(input.to) ||
    input.from > input.to
  )
    throw new HarnessError("invalidInput");
  if (!committed) return { records: [], cursor: null, complete: true };
  if (
    (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) ||
    (input.cursor?.afterSeq !== undefined &&
      (!Number.isSafeInteger(input.cursor.afterSeq) || input.cursor.afterSeq < 0))
  )
    throw new HarnessError("invalidInput");
  const index = new HarnessTimeIndex(path + ".time-index");
  const matches = await index.matching(committed, input.from, input.to, input.cursor?.indexOffset ?? 0, 32);
  const limit = Math.min(100, Math.max(1, input.limit ?? 30)),
    records: Array<{
      seq: number;
      timestamp: string;
      type: string;
      messageId: string;
      runtimeId?: string;
      runId?: string;
      text: string;
      truncated: boolean;
    }> = [];
  const file = await openHistoryFile(path);
  let readBytes = 0,
    returnedBytes = 0;
  try {
    for (const block of matches.blocks) {
      if (block.end - block.start > 8 * 1024 * 1024) throw new HarnessError("historyCorrupt", 503);
      if (readBytes + block.end - block.start > 8 * 1024 * 1024)
        return { records, cursor: { indexOffset: block.indexOffset }, complete: false };
      readBytes += block.end - block.start;
      const bytes = Buffer.alloc(block.end - block.start);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, block.start + offset);
        if (!result.bytesRead) throw new HarnessError("historyCorrupt", 503);
        offset += result.bytesRead;
      }
      for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
        const frame = historyFrame(line),
          event = frame.event;
        if (
          event.seq <= (input.cursor?.afterSeq ?? 0) ||
          frame.timestampMs < input.from ||
          frame.timestampMs > input.to
        )
          continue;
        const content =
          event.type === "message" ? event.message.text : event.type === "text" ? event.text : event.status;
        if (input.query && !content.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) continue;
        const snippet = new TextDecoder().decode(Buffer.from(content).subarray(0, 2048), { stream: true });
        const snippetBytes = Buffer.byteLength(snippet) + 300;
        if (returnedBytes + snippetBytes > 48 * 1024)
          return {
            records,
            cursor: { indexOffset: block.indexOffset, afterSeq: records.at(-1)?.seq ?? input.cursor?.afterSeq ?? 0 },
            complete: false,
          };
        returnedBytes += snippetBytes;
        records.push({
          seq: event.seq,
          timestamp: new Date(frame.timestampMs).toISOString(),
          runtimeId: event.runtimeId ?? (event.type === "message" ? event.message.runtimeId : undefined),
          runId: event.runId ?? (event.type === "message" ? event.message.runId : undefined),
          type: event.type,
          messageId: event.type === "message" ? event.message.id : event.messageId,
          text: snippet,
          truncated: snippet !== content,
        });
        if (records.length >= limit)
          return { records, cursor: { indexOffset: block.indexOffset, afterSeq: event.seq }, complete: false };
      }
    }
    return {
      records,
      cursor: matches.next === null ? null : { indexOffset: matches.next },
      complete: matches.next === null,
    };
  } finally {
    await file.close();
  }
}
