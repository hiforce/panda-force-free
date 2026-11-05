import { isRecord } from "../../shared/records.js";
import type { RpcId, RpcRecord } from "../../shared/rpc-types.js";
export interface BrowserParams extends RpcRecord {
  threadId?: string;
  cwd?: string;
  name?: string;
  limit?: number;
  cursor?: string | null;
  includeTurns?: boolean;
  excludeTurns?: boolean;
  itemsView?: string;
  input?: import("../../shared/data-contracts.js").NativeInput[];
}
export interface BrowserEnvelope {
  id?: RpcId;
  type: string;
  method: string;
  params: BrowserParams;
  requestId?: RpcId;
  result?: unknown;
  error?: unknown;
}
export function browserEnvelope(value: unknown): BrowserEnvelope {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Unsupported browser bridge message");
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number")
    throw new Error("Invalid bridge identity");
  if (value.type === "rpc" && typeof value.method !== "string") throw new Error("Invalid bridge method");
  if (value.params !== undefined && !isRecord(value.params)) throw new Error("Bridge parameters must be an object");
  const params = value.params || {};
  if (!isRecord(params)) throw new Error("Invalid bridge parameters");
  for (const key of ["threadId", "cwd", "name", "itemsView"])
    if (params[key] !== undefined && typeof params[key] !== "string")
      throw new Error("Invalid bridge parameter: " + key);
  for (const key of ["includeTurns", "excludeTurns"])
    if (params[key] !== undefined && typeof params[key] !== "boolean")
      throw new Error("Invalid bridge parameter: " + key);
  if (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isFinite(params.limit)))
    throw new Error("Invalid bridge limit");
  if (params.cursor !== undefined && params.cursor !== null && typeof params.cursor !== "string")
    throw new Error("Invalid bridge cursor");
  if (
    params.input !== undefined &&
    (!Array.isArray(params.input) ||
      !params.input.every(
        (part) =>
          isRecord(part) &&
          ((part.type === "text" && typeof part.text === "string") ||
            (part.type === "image" && typeof part.url === "string") ||
            (part.type === "localImage" && typeof part.path === "string")),
      ))
  )
    throw new Error("Invalid bridge input");
  if (value.requestId !== undefined && typeof value.requestId !== "string" && typeof value.requestId !== "number")
    throw new Error("Invalid Codex request id");
  return {
    ...value,
    type: value.type,
    method: typeof value.method === "string" ? value.method : "",
    params,
  } as BrowserEnvelope;
}
