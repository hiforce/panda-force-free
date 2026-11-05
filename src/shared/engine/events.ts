import { isRecord } from "../records.js";
import type { EngineEnvelope } from "./contracts.js";

/** Validate the portable v1 envelope without interpreting opaque provider extensions. */
export function engineEnvelope(value: unknown): EngineEnvelope {
  if (!isRecord(value)) throw new Error("Invalid engine protocol message");
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number")
    throw new Error("Invalid engine request identity");
  if (value.method !== undefined && typeof value.method !== "string") throw new Error("Invalid engine method");
  if (value.params !== undefined && !isRecord(value.params)) throw new Error("Invalid engine notification parameters");
  if (isRecord(value.params)) {
    const params = value.params;
    for (const field of ["threadId", "turnId", "threadName", "name"])
      if (params[field] !== undefined && typeof params[field] !== "string")
        throw new Error("Invalid engine notification identity");
    if (params.requestId !== undefined && typeof params.requestId !== "string" && typeof params.requestId !== "number")
      throw new Error("Invalid engine request identity");
    if (
      value.method === "thread/status/changed" &&
      params.status !== undefined &&
      (!isRecord(params.status) || typeof params.status.type !== "string")
    )
      throw new Error("Invalid engine status");
    if (params.turn !== undefined && (!isRecord(params.turn) || typeof params.turn.id !== "string"))
      throw new Error("Invalid engine turn");
    if (
      params.item !== undefined &&
      (!isRecord(params.item) || typeof params.item.id !== "string" || typeof params.item.type !== "string")
    )
      throw new Error("Invalid engine item");
  }
  return value as EngineEnvelope;
}
