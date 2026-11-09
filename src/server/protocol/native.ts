import type { NativeTurn } from "../../shared/data-contracts.js";
import { isRecord } from "../../shared/records.js";
import type { RpcRecord } from "../../shared/rpc-types.js";

export type NativeItem = NativeTurn["items"][number];
export type NativeThread = RpcRecord & {
  id: string;
  turns: NativeTurn[];
  path?: string;
  cwd?: string;
  canAcceptDirectInput?: boolean;
};
export type {
  EngineEnvelope as NativeEnvelope,
  EngineEventParameters as NativeNotificationParams,
} from "../../shared/engine/contracts.js";
export { codexEnvelope as nativeEnvelope } from "./codex-envelope.js";

export function nativeItem(value: unknown): NativeItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return null;
  return { ...value, id: value.id, type: value.type };
}
export function nativeTurn(value: unknown): NativeTurn | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    ...value,
    id: value.id,
    status: typeof value.status === "string" ? value.status : "",
    items: Array.isArray(value.items)
      ? value.items.flatMap((item) => {
          const parsed = nativeItem(item);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}
export function nativeThread(value: unknown): NativeThread | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    ...value,
    id: value.id,
    turns: Array.isArray(value.turns)
      ? value.turns.flatMap((turn) => {
          const parsed = nativeTurn(turn);
          return parsed ? [parsed] : [];
        })
      : [],
    path: typeof value.path === "string" ? value.path : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    canAcceptDirectInput: value.canAcceptDirectInput === true,
  };
}
export function threadFromResult(value: unknown): NativeThread | null {
  return isRecord(value) ? nativeThread(value.thread) : null;
}
export function resultPage<T>(value: unknown, decode: (item: unknown) => T | null) {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Invalid native list response");
  return {
    ...value,
    data: value.data.flatMap((item) => {
      const parsed = decode(item);
      return parsed === null ? [] : [parsed];
    }),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

export function nativeItemRecord(value: unknown) {
  if (!isRecord(value) || typeof value.turnId !== "string") return null;
  const item = nativeItem(value.item);
  return item
    ? {
        ...value,
        turnId: value.turnId,
        item,
        startedAtMs: typeof value.startedAtMs === "number" ? value.startedAtMs : null,
      }
    : null;
}
