import { basename, resolve } from "node:path";
import { readServiceLogConfig } from "../src/server/logging/config.js";
import { runLoggedProcess } from "../src/server/logging/supervisor.js";

try {
  const root = resolve(import.meta.dir, "..");
  const entry = resolve(root, basename(import.meta.dir) === "dist" ? "dist/server.js" : "src/server/main.ts");
  process.exitCode = await runLoggedProcess({
    command: [process.execPath, entry, ...process.argv.slice(2)],
    cwd: root,
    logging: readServiceLogConfig(),
  });
} catch (error) {
  console.error("[PandaForce] Service startup failed:", error);
  process.exitCode = 1;
}
