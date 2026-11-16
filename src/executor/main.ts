import { readFileSync, writeFileSync, mkdirSync, existsSync, chownSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { executorConfig } from "./config.js";
import { ExecutionStore } from "./store.js";
import { DockerBuildDriver } from "./docker/driver.js";
import { ExecutionService } from "./service.js";
import { executionHandler } from "./http.js";
import { RESOURCE_FRAME_MAX } from "../shared/builds/resource-frame.js";
import { createRotatingLog } from "../server/logging/rotating-file.js";

const config = executorConfig(process.env);
if (process.argv.includes("init")) {
  mkdirSync(dirname(config.tokenFile), { recursive: true, mode: 0o755 });
  if (!existsSync(config.tokenFile))
    writeFileSync(config.tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  const uid = Number(process.env.PUID || 1000),
    gid = Number(process.env.PGID || 1000);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0)
    throw new Error("Invalid executor token owner");
  chownSync(config.tokenFile, uid, gid);
  process.exit(0);
}
const token = readFileSync(config.tokenFile, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid executor token");
const log = createRotatingLog({
  directory: join(config.stateRoot, "logs"),
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 5,
});
const report = (event: object) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\n";
  process.stdout.write(line);
  log.write(line);
};
const store = new ExecutionStore(config.stateRoot),
  service = new ExecutionService(store, new DockerBuildDriver(config, store.owner), report);
await service.recover();
const retention = setInterval(() => {
  try {
    store.prune();
  } catch {
    report({ event: "executor.retention.failed" });
  }
}, 3600000);
retention.unref();
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  maxRequestBodySize: RESOURCE_FRAME_MAX,
  fetch: executionHandler(service, token),
});
report({ event: "executor.ready", port: server.port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(retention);
    service.close();
    void server.stop();
    setTimeout(() => process.exit(0), 5000);
  });
