import { isAbsolute } from "node:path";
import type { CodexConnection, CodexTransportFactory } from "../../engines/codex-transport.js";
import type { CreationEngines } from "../runtime/contracts.js";
import { CreationError } from "../contracts.js";
import { isolatedApplicationEngines } from "../../engines/application-tools/factory.js";

/** Each run gets an empty directory visible to its native engine. Model text never selects a workspace or process. */
export function creationEngines(
  options: {
    connection: CodexConnection;
    scratchRoot: string;
    version: string;
    engineId: string;
  },
  factory?: CodexTransportFactory,
): CreationEngines {
  if (!isAbsolute(options.scratchRoot)) throw new CreationError("invalidInput");
  const engines = isolatedApplicationEngines({ ...options, purpose: "creation" }, factory);
  return {
    select(profile) {
      if (profile.engineId !== "codex" || options.engineId !== "codex") throw new CreationError("unavailable");
      return engines.select(profile);
    },
  };
}
