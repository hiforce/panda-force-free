import { isRecord } from "../../../shared/records.js";

/** An application freezes the engine's one advertised default instead of guessing a model from list order. */
export function applicationDefaultModel(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Application model unavailable");
  const defaults = value.data.filter((model) => isRecord(model) && model.isDefault === true);
  if (defaults.length !== 1) throw new Error("Application model unavailable");
  const model = defaults[0].model ?? defaults[0].id;
  if (typeof model !== "string" || !model.trim() || model.length > 128 || model.includes("\0"))
    throw new Error("Application model unavailable");
  return model;
}
