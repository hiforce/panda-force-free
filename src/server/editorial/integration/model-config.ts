import { readFileSync, existsSync, statSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { EditorialModel } from "../model/contracts.js";
import { ResponsesEditorialModel } from "../adapters/responses.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";

/** Optional model configuration must not prevent writing, authentication or local review from starting. */
export function editorialModelSettings(stateRoot: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    return { models: configuredEditorialModels(stateRoot, env), configurationInvalid: false };
  } catch {
    reportDiagnostic("editorial-configuration", new Error("Invalid editorial processor configuration"));
    return { models: new Map<string, EditorialModel>(), configurationInvalid: true };
  }
}

function configError(): never {
  throw new Error("Invalid editorial processor configuration");
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}]/u.test(value)) configError();
  return value.trim();
}
/** Only administrator-controlled startup configuration selects endpoints and secret files, never document input. */
export function configuredEditorialModels(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, EditorialModel> {
  const path = env.PANDA_FORCE_EDITORIAL_CONFIG_FILE || join(stateRoot, "config", "editorial-processors.json");
  if (!existsSync(path)) {
    if (env.PANDA_FORCE_EDITORIAL_CONFIG_FILE) configError();
    return new Map();
  }
  const info = statSync(path);
  if (!info.isFile() || info.size > 65536) configError();
  const bytes = readFileSync(path);
  if (bytes.length > 65536) configError();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    configError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) configError();
  const root = value as Record<string, unknown>;
  if (
    root.schema !== 1 ||
    Object.keys(root).some((key) => !["schema", "processors"].includes(key)) ||
    !Array.isArray(root.processors) ||
    root.processors.length > 16
  )
    configError();
  const models = new Map<string, EditorialModel>();
  for (const item of root.processors) {
    if (!item || typeof item !== "object" || Array.isArray(item)) configError();
    const entry = item as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        (key) =>
          !["id", "kind", "model", "endpoint", "apiKeyFile", "authentication", "allowInsecureHttp"].includes(key),
      )
    )
      configError();
    if (entry.kind !== "responses") configError();
    const id = text(entry.id, 80),
      model = text(entry.model, 128),
      endpoint = text(entry.endpoint, 2048);
    if (!/^[a-z][a-z0-9.-]*$/.test(id) || models.has(id)) configError();
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      configError();
    }
    if (url.username || url.password || url.hash || url.search || !["https:", "http:"].includes(url.protocol))
      configError();
    if (entry.allowInsecureHttp !== undefined && typeof entry.allowInsecureHttp !== "boolean") configError();
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      entry.allowInsecureHttp !== true
    )
      configError();
    const authentication = entry.authentication ?? "bearer";
    if (!["bearer", "none"].includes(String(authentication))) configError();
    const keyFile = authentication === "bearer" ? text(entry.apiKeyFile, 4096) : null;
    if ((keyFile && !isAbsolute(keyFile)) || (authentication === "none" && entry.apiKeyFile !== undefined))
      configError();
    models.set(
      id,
      new ResponsesEditorialModel({
        id,
        model,
        endpoint: url.href,
        credentialBinding: authentication === "bearer" ? keyFile! : "none",
        credential: async () => {
          if (!keyFile) return null;
          const file = await open(keyFile, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const info = await file.stat();
            if (!info.isFile() || info.size > 16384) throw new Error("Editorial processor credential unavailable");
            const buffer = Buffer.alloc(16385),
              read = await file.read(buffer, 0, buffer.length, 0);
            const key = buffer.subarray(0, read.bytesRead).toString("utf8").trim();
            if (read.bytesRead > 16384) throw new Error("Editorial processor credential unavailable");
            if (!key || key.length > 16384 || /[\p{Cc}\p{Z}]/u.test(key))
              throw new Error("Editorial processor credential unavailable");
            return key;
          } finally {
            await file.close();
          }
        },
      }),
    );
  }
  return models;
}
