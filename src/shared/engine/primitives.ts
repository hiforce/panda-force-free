export type EngineCapability =
  | "sessions"
  | "input"
  | "streaming"
  | "approvals"
  | "questions"
  | "models"
  | "account"
  | "usage"
  | "permissions"
  | "goals"
  | "queue"
  | "review";
export type EngineOperation =
  | `session.${"list" | "loaded" | "read" | "create" | "resume" | "fork" | "delete" | "rename" | "turns" | "items" | "subscribe" | "unsubscribe" | "compact"}`
  | `input.${"start" | "steer" | "interrupt"}`
  | "model.list"
  | "permission.list"
  | "account.read"
  | "account.logout"
  | "usage.read"
  | `goal.${"read" | "set" | "clear"}`
  | `queue.${"list" | "add" | "delete" | "start"}`
  | "review.start";

export interface EngineDescriptor {
  readonly id: string;
  readonly name: string;
  readonly kind: "conversation";
  readonly protocolVersion: 1;
  readonly capabilities: readonly EngineCapability[];
}
