import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createEvictionLogger } from "../misc/eviction-log.js";
import { applyRolloutEvent, newState } from "./rollout-events.js";
export { applyRolloutEvent } from "./rollout-events.js";
const logEviction = createEvictionLogger("live-sessions");

export function parseRollout(text) {
  const state = newState();
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      applyRolloutEvent(state, JSON.parse(line));
    } catch {
      /* A partially-written final line is retried on the next read. */
    }
  }
  return state;
}

export class LiveSessionStore {
  #entries = new Map();
  #maxReadBytes;

  constructor({ maxReadBytes = 2 * 1024 * 1024 } = {}) {
    this.#maxReadBytes = maxReadBytes;
  }

  /** @param {string} path @param {{turn?: import("../../shared/data-contracts.js").NativeTurn}} options */
  read(path, { turn } = {}) {
    let entry = this.#entries.get(path);
    const fd = openSync(path, "r");
    try {
      const { size, ino } = fstatSync(fd);
      if (!entry || size < entry.offset || entry.ino !== ino || size - entry.offset > this.#maxReadBytes) {
        const offset = Math.max(0, size - this.#maxReadBytes);
        entry = {
          ino,
          offset,
          remainder: "",
          skipPartial: offset > 0,
          decoder: new StringDecoder("utf8"),
          state: newState(),
        };
        if (turn && offset > 0) {
          entry.state.turn = { ...turn, items: [] };
          entry.state.active = turn.status === "inProgress";
          entry.state.userSequence = 1;
        }
      }
      const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, size - entry.offset));
      while (entry.offset < size) {
        const count = readSync(fd, bytes, 0, Math.min(bytes.length, size - entry.offset), entry.offset);
        if (!count) break;
        entry.offset += count;
        const lines = (entry.remainder + entry.decoder.write(bytes.subarray(0, count))).split("\n");
        entry.remainder = lines.pop() || "";
        for (const line of lines) {
          if (entry.skipPartial) {
            entry.skipPartial = false;
            continue;
          }
          if (line.length > 512 * 1024) continue;
          if (!line.trim()) continue;
          try {
            applyRolloutEvent(entry.state, JSON.parse(line));
          } catch {
            /* Ignore malformed historical records. */
          }
        }
        if (entry.remainder.length > 512 * 1024) {
          entry.remainder = "";
          entry.skipPartial = true;
        }
        if (entry.state.turn?.items.length > 128) {
          entry.state.turn.items = entry.state.turn.items.slice(-128);
          entry.state.itemIndex = new Map(entry.state.turn.items.map((item, index) => [item.id, index]));
          for (const [id, itemId] of entry.state.commandCalls)
            if (!entry.state.itemIndex.has(itemId)) entry.state.commandCalls.delete(id);
        }
      }
      if (turn && turn.id === entry.state.turn?.id && turn.status !== "inProgress") entry.state.active = false;
      this.#entries.delete(path);
      this.#entries.set(path, entry);
      while (this.#entries.size > 8) {
        this.#entries.delete(this.#entries.keys().next().value);
        logEviction("rollout reader");
      }
      return {
        active: entry.state.active,
        lastEventAt: entry.state.lastEventAt,
        turn: entry.state.active && entry.state.turn ? structuredClone(entry.state.turn) : null,
        questionTurns: structuredClone([...entry.state.questionTurns.values()]),
        tokenUsage: entry.state.tokenUsage ? structuredClone(entry.state.tokenUsage) : undefined,
      };
    } finally {
      closeSync(fd);
    }
  }

  clear() {
    this.#entries.clear();
  }
}
