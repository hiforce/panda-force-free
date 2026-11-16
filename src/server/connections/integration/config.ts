import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PublicationRoot } from "../../../shared/connections/contracts.js";

export function sftpLimits(env: NodeJS.ProcessEnv = process.env) {
  const seconds = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value * 1000;
  };
  return {
    operationMs: seconds("PANDA_FORCE_SFTP_OPERATION_TIMEOUT_SECONDS", 15, 5, 120),
    sessionMs: seconds("PANDA_FORCE_SFTP_SESSION_TIMEOUT_SECONDS", 300, 60, 3600),
  };
}

/** Paths are inside the application container; Compose bind mounts and Kubernetes volumes work identically. */
export function publicationRoots(stateRoot: string, env: NodeJS.ProcessEnv = process.env): PublicationRoot[] {
  if (env.PANDA_FORCE_PUBLICATION_ROOTS) {
    let value: unknown;
    try {
      value = JSON.parse(env.PANDA_FORCE_PUBLICATION_ROOTS);
    } catch {
      throw new Error("Invalid PANDA_FORCE_PUBLICATION_ROOTS JSON");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((path) => typeof path !== "string")
    )
      throw new Error("PANDA_FORCE_PUBLICATION_ROOTS must map root names to absolute directories");
    return Object.entries(value).map(([id, path]) => ({ id, path: path as string }));
  }
  const path = join(stateRoot, "published");
  mkdirSync(path, { recursive: true, mode: 0o755 });
  return [{ id: "local", path }];
}
