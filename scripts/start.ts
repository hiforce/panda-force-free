import { basename, resolve } from "node:path";
import { readServiceLogConfig } from "../src/server/logging/config.js";
import { runRestartableLoggedProcess } from "../src/server/logging/managed-restart.js";

try {
  const root = resolve(import.meta.dir, "..");
  const gateway = process.env.PANDA_FORCE_CLUSTER_ROLE === "gateway";
  const entry = resolve(
    root,
    basename(import.meta.dir) === "dist"
      ? gateway
        ? "dist/gateway.js"
        : "dist/server.js"
      : gateway
        ? "src/server/cluster/gateway.ts"
        : "src/server/main.ts",
  );
  process.exitCode = await runRestartableLoggedProcess({
    command: [process.execPath, entry, ...process.argv.slice(2)],
    cwd: root,
    logging: readServiceLogConfig(),
  });
} catch (error) {
  console.error("[PandaForce] Service startup failed:", error);
  process.exitCode = 1;
}
