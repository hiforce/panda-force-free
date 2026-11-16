import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ContentAccessError, contentAccessOwner, type ContentAccessPolicy } from "../contracts.js";
/** Only trusted installation configuration selects shared access or bootstraps external administrators. */
export function contentAccessPolicy(root: string, env: NodeJS.ProcessEnv = process.env): ContentAccessPolicy {
  const path = env.PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE || join(root, "config", "content-access.json");
  if (!existsSync(path)) {
    if (env.PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE) throw new ContentAccessError("unavailable");
    return { mode: "restricted", administrators: new Set() };
  }
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 32768) throw new Error("Invalid access policy");
    const bytes = readFileSync(path);
    if (bytes.length > 32768) throw new Error("Invalid access policy");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid access policy");
    const p = value as Record<string, unknown>;
    if (
      Object.keys(p).some((key) => !["schema", "mode", "administrators"].includes(key)) ||
      p.schema !== 1 ||
      !["restricted", "shared"].includes(String(p.mode)) ||
      !Array.isArray(p.administrators) ||
      p.administrators.length > 256
    )
      throw new Error("Invalid access policy");
    const administrators = new Set(p.administrators.map(contentAccessOwner));
    if (administrators.size !== p.administrators.length) throw new Error("Duplicate access administrator");
    return { mode: p.mode as ContentAccessPolicy["mode"], administrators };
  } catch {
    throw new ContentAccessError("unavailable");
  }
}
