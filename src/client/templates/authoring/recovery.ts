import type { TemplateRecoveryPort, TemplateRecoveryValue } from "./session.js";
import { normalizeRichBody } from "../../../shared/documents/rich-body.js";

export function templateRecovery(
  identity: string,
  id: string,
  storage?: Storage,
  memory = new Map<string, string>(),
  leases = new Map<string, symbol>(),
): TemplateRecoveryPort {
  const key = "panda-force.template-draft.v1:" + encodeURIComponent(identity) + ":" + id;
  const lease = Symbol();
  leases.set(key, lease);
  const current = () => {
    if (leases.get(key) !== lease) throw Error("Template recovery owner changed");
  };
  let disk: Storage | undefined;
  try {
    disk = storage || localStorage;
  } catch {
    /* Memory retains a working copy until the page is closed. */
  }
  return {
    read() {
      const raw = memory.get(key) || disk?.getItem(key);
      if (!raw) return null;
      if (raw.length > 6 * 1024 * 1024) throw Error("Invalid template recovery");
      const value = JSON.parse(raw) as TemplateRecoveryValue;
      if (
        value.schema !== 1 ||
        !Number.isSafeInteger(value.baseRevision) ||
        value.baseRevision < 1 ||
        !value.working ||
        !Array.isArray(value.working.parameters) ||
        !Array.isArray(value.working.contentSlots) ||
        (value.pending && (value.pending.id !== id || !Number.isSafeInteger(value.pending.expectedRevision)))
      )
        throw Error("Invalid template recovery");
      value.working.body = normalizeRichBody(value.working.body);
      if (value.pending) value.pending.definition.body = normalizeRichBody(value.pending.definition.body);
      return value;
    },
    write(value) {
      current();
      const raw = JSON.stringify(value);
      memory.set(key, raw);
      if (!disk) throw Error("Template recovery storage unavailable");
      disk.setItem(key, raw);
    },
    clear() {
      current();
      memory.delete(key);
      disk?.removeItem(key);
    },
  };
}
export function templateRecoveries(identity: string, storage?: Storage) {
  const memory = new Map<string, string>(),
    leases = new Map<string, symbol>();
  return (id: string) => templateRecovery(identity, id, storage, memory, leases);
}
