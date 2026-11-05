import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorCode } from "./../../shared/errors.js";

export const DEFAULT_LOGGING = Object.freeze({
  enabled: true,
  directory: "../logs",
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 10,
});

export function readServiceLogConfig(env = process.env) {
  const stateRoot = resolve(env.PANDA_FORCE_HOME || join(env.HOME || homedir(), ".panda-force"));
  const configFile = resolve(env.PANDA_FORCE_CONFIG_FILE || join(stateRoot, "config", "panda-force.json"));
  let source;
  try {
    source = readFileSync(configFile, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, logging: DEFAULT_LOGGING }, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    try {
      linkSync(temporary, configFile);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      unlinkSync(temporary);
    }
    source = readFileSync(configFile, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Invalid PandaForce JSON configuration: ${configFile}`);
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.logging ||
    typeof parsed.logging !== "object" ||
    Array.isArray(parsed.logging)
  )
    throw new Error(`Unsupported PandaForce logging configuration: ${configFile}`);
  for (const key of Object.keys(parsed.logging)) {
    if (!Object.hasOwn(DEFAULT_LOGGING, key)) throw new Error(`Unknown PandaForce logging option: ${key}`);
  }
  const logging = { ...DEFAULT_LOGGING, ...parsed.logging };
  if (env.PANDA_FORCE_LOG_ENABLED !== undefined) {
    if (!/^(true|false)$/.test(env.PANDA_FORCE_LOG_ENABLED))
      throw new Error("PANDA_FORCE_LOG_ENABLED must be true or false");
    logging.enabled = env.PANDA_FORCE_LOG_ENABLED === "true";
  }
  if (env.PANDA_FORCE_LOG_DIR) logging.directory = env.PANDA_FORCE_LOG_DIR;
  if (env.PANDA_FORCE_LOG_MAX_BYTES !== undefined) logging.maxFileBytes = Number(env.PANDA_FORCE_LOG_MAX_BYTES);
  if (env.PANDA_FORCE_LOG_MAX_FILES !== undefined) logging.maxFiles = Number(env.PANDA_FORCE_LOG_MAX_FILES);
  if (typeof logging.enabled !== "boolean" || typeof logging.directory !== "string" || !logging.directory.trim())
    throw new Error("PandaForce logging.enabled must be boolean and logging.directory must be a nonempty path");
  if (!Number.isSafeInteger(logging.maxFileBytes) || logging.maxFileBytes < 1024 || logging.maxFileBytes > 1024 ** 3)
    throw new Error("PandaForce logging.maxFileBytes must be an integer between 1024 and 1073741824");
  if (!Number.isSafeInteger(logging.maxFiles) || logging.maxFiles < 1 || logging.maxFiles > 1000)
    throw new Error("PandaForce logging.maxFiles must be an integer between 1 and 1000");
  return { ...logging, directory: resolve(dirname(configFile), logging.directory), configFile, stateRoot };
}
