import type { EngineDriver } from "../../shared/engine/contracts.js";
import { operationForRpc } from "../../shared/engine/operations.js";
import { createEngineRegistry } from "./registry.js";

/** Existing browser/API clients keep their v1 names while application commands use canonical operations. */
export function createEngineRpc(driver: EngineDriver) {
  const registry = createEngineRegistry();
  registry.register(driver);
  return (method: string, params: Record<string, unknown> = {}) => {
    const operation = operationForRpc(method);
    if (!operation) throw new Error("Unsupported PandaForce engine method: " + method);
    return registry.execute(driver.descriptor.id, operation, params);
  };
}
