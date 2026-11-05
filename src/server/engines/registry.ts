import type { CommandTool, EngineDriver, EngineEvent } from "../../shared/engine/contracts.js";
import { ENGINE_OPERATIONS, isEngineOperation } from "../../shared/engine/operations.js";

export class EngineCapabilityError extends Error {
  readonly code = "engine_capability_unavailable";
}
/** Drivers and command tools use distinct registries and cannot impersonate each other. */
export function createEngineRegistry() {
  const engines = new Map<string, EngineDriver>();
  const tools = new Map<string, CommandTool>();
  const requireId = (id: string) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid engine or tool identity");
  };
  return {
    register(driver: EngineDriver) {
      requireId(driver.descriptor.id);
      if (driver.descriptor.kind !== "conversation" || driver.descriptor.protocolVersion !== 1)
        throw new Error("Unsupported conversation engine contract");
      if (engines.has(driver.descriptor.id) || tools.has(driver.descriptor.id))
        throw new Error("Duplicate engine identity");
      engines.set(driver.descriptor.id, driver);
    },
    registerTool(tool: CommandTool) {
      requireId(tool.descriptor.id);
      if (tool.descriptor.kind !== "command-tool") throw new Error("Unsupported command tool contract");
      if (engines.has(tool.descriptor.id) || tools.has(tool.descriptor.id)) throw new Error("Duplicate tool identity");
      tools.set(tool.descriptor.id, tool);
    },
    select(id: string) {
      const driver = engines.get(id);
      if (!driver) throw new EngineCapabilityError("Conversation engine is not installed: " + id);
      return driver;
    },
    descriptors: () => [...engines.values()].map((engine) => engine.descriptor),
    toolDescriptors: () => [...tools.values()].map((tool) => tool.descriptor),
    async execute(id: string, operation: string, params: Record<string, unknown> = {}) {
      const driver = this.select(id);
      if (
        !isEngineOperation(operation) ||
        !driver.descriptor.capabilities.includes(ENGINE_OPERATIONS[operation].capability)
      )
        throw new EngineCapabilityError("Engine operation is unavailable: " + operation);
      return driver.execute(operation, params);
    },
    async executeTool(id: string, arguments_: readonly string[], options?: { signal?: AbortSignal }) {
      const tool = tools.get(id);
      if (!tool) throw new EngineCapabilityError("Command tool is not installed: " + id);
      return tool.execute(arguments_, options);
    },
    subscribe(id: string, listener: (event: EngineEvent) => void) {
      return this.select(id).subscribe(listener);
    },
  };
}
