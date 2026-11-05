import type { EngineCapability, EngineOperation } from "./primitives.js";
export type { EngineOperation } from "./primitives.js";

/** Compatibility names belong to PandaForce's versioned API, never to a driver implementation. */
export const ENGINE_OPERATIONS = {
  "session.list": { rpc: "thread/list", capability: "sessions" },
  "session.loaded": { rpc: "thread/loaded/list", capability: "sessions" },
  "session.read": { rpc: "thread/read", capability: "sessions" },
  "session.create": { rpc: "thread/start", capability: "sessions" },
  "session.resume": { rpc: "thread/resume", capability: "sessions" },
  "session.fork": { rpc: "thread/fork", capability: "sessions" },
  "session.delete": { rpc: "thread/delete", capability: "sessions" },
  "session.rename": { rpc: "thread/name/set", capability: "sessions" },
  "session.turns": { rpc: "thread/turns/list", capability: "sessions" },
  "session.items": { rpc: "thread/items/list", capability: "sessions" },
  "session.subscribe": { rpc: "thread/subscribe", capability: "streaming" },
  "session.unsubscribe": { rpc: "thread/unsubscribe", capability: "streaming" },
  "session.compact": { rpc: "thread/compact/start", capability: "sessions" },
  "input.start": { rpc: "turn/start", capability: "input" },
  "input.steer": { rpc: "turn/steer", capability: "input" },
  "input.interrupt": { rpc: "turn/interrupt", capability: "input" },
  "model.list": { rpc: "model/list", capability: "models" },
  "permission.list": { rpc: "permissionProfile/list", capability: "permissions" },
  "account.read": { rpc: "account/read", capability: "account" },
  "account.logout": { rpc: "account/logout", capability: "account" },
  "usage.read": { rpc: "account/rateLimits/read", capability: "usage" },
  "goal.read": { rpc: "thread/goal/get", capability: "goals" },
  "goal.set": { rpc: "thread/goal/set", capability: "goals" },
  "goal.clear": { rpc: "thread/goal/clear", capability: "goals" },
  "queue.start": { rpc: "thread/queue/start", capability: "queue" },
  "queue.list": { rpc: "thread/queue/list", capability: "queue" },
  "queue.add": { rpc: "thread/queue/add", capability: "queue" },
  "queue.delete": { rpc: "thread/queue/delete", capability: "queue" },
  "review.start": { rpc: "review/start", capability: "review" },
} as const satisfies Record<EngineOperation, { rpc: string; capability: EngineCapability }>;

const aliases = new Map<string, EngineOperation>(
  Object.entries(ENGINE_OPERATIONS).map(([operation, descriptor]) => [descriptor.rpc, operation as EngineOperation]),
);
export function operationForRpc(method: string): EngineOperation | undefined {
  return aliases.get(method);
}
export function isEngineOperation(value: string): value is EngineOperation {
  return Object.hasOwn(ENGINE_OPERATIONS, value);
}
