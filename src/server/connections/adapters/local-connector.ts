import type { ConnectionConnector } from "../connector-port.js";
import type { LocalTargetPolicy } from "../target-port.js";
import { localConnectionInput } from "../validation.js";
import { ConnectionError } from "../errors.js";

export function localConnector(targets: LocalTargetPolicy): ConnectionConnector {
  return {
    id: "local-site",
    parse: localConnectionInput,
    roots: () => targets.roots(),
    ready: () => {},
    target: (input) => {
      if (input.connector !== "local-site") throw new ConnectionError("invalidInput");
      return targets.resolve(input);
    },
    inspect: async (_owner, input) => {
      if (input.connector !== "local-site") throw new ConnectionError("invalidInput");
      await targets.inspect(targets.resolve(input), input.id);
    },
    test: async (_owner, connection) => {
      if (connection.connector !== "local-site") throw new ConnectionError("invalidInput");
      const path = targets.resolve(connection);
      await targets.test(path, connection.id);
      return { capabilities: ["site.publish"], servedPath: path + "/current", atomicSwitch: true };
    },
    credential: () => {
      throw new ConnectionError("unsupportedConnector");
    },
  };
}
