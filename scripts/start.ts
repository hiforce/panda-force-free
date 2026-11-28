import { basename, resolve } from "node:path";
import { DEFAULT_LOGGING, readServiceLogConfig } from "../src/server/logging/config.js";
import { runRestartableLoggedProcess } from "../src/server/logging/managed-restart.js";
import { runLoggedProcess } from "../src/server/logging/supervisor.js";

const workerEntry = {
  "creation-media": "src/server/creation/integration/media-executors/broker-main.ts",
  "harness-process": "src/server/harness/process-worker.ts",
  terminal: "src/server/terminal/worker-main.ts",
} as const;

try {
  const root = resolve(import.meta.dir, "..");
  const role = process.env.PANDA_FORCE_SERVICE_ROLE;
  if (role) {
    if (
      !Object.hasOwn(workerEntry, role) ||
      process.env.PANDA_FORCE_CLUSTER_ROLE ||
      process.getuid?.() === 0 ||
      process.argv.length !== 2
    )
      throw Error("Invalid application image worker role or launch identity");
    // Worker processes log to the container and must never initialize the application state.
    process.exitCode = await runLoggedProcess({
      command: [process.execPath, resolve(root, workerEntry[role as keyof typeof workerEntry])],
      cwd: root,
      logging: { ...DEFAULT_LOGGING, enabled: false },
    });
  } else {
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
  }
} catch (error) {
  console.error("[PandaForce] Service startup failed:", error);
  process.exitCode = 1;
}
