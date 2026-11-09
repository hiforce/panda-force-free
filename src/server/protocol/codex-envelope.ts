import { isRecord } from "../../shared/records.js";
import { engineEnvelope } from "../../shared/engine/events.js";

/** A Goal may change outside a turn. Normalize its native nullable identity at the provider boundary. */
export function codexEnvelope(value: unknown) {
  if (
    isRecord(value) &&
    value.method === "thread/goal/updated" &&
    isRecord(value.params) &&
    value.params.turnId === null
  ) {
    const { turnId: _turnId, ...params } = value.params;
    return engineEnvelope({ ...value, params });
  }
  return engineEnvelope(value);
}
