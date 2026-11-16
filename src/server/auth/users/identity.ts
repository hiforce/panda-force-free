import type { IncomingMessage } from "node:http";
import type { LocalIdentity } from "./contracts.js";
const identities = new WeakMap<IncomingMessage, LocalIdentity>();
/** Authentication owns this request-scoped principal; caller-supplied headers never select an owner. */
export function localRequestIdentity(request?: IncomingMessage): LocalIdentity | null {
  return request ? (identities.get(request) ?? null) : null;
}
export function recordLocalIdentity(request: IncomingMessage, identity: LocalIdentity | null) {
  if (identity) identities.set(request, identity);
  else identities.delete(request);
}
