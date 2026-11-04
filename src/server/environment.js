import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
// Keep migration compatibility at one boundary; public configuration uses PandaForce.
export function pandaEnvironment(source = process.env) {
  const env = { ...source };
  const legacyPrefix = "CODEX_WEBUI_";
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith(legacyPrefix)) continue;
    const canonical = "PANDA_FORCE_" + name.slice(legacyPrefix.length);
    // Explicit empty values also override legacy settings.
    if (source[canonical] === undefined && value !== undefined) env[canonical] = value;
  }
  return env;
}

// Reuse existing application state during upgrades; never move or delete it.
export function existingApplicationPath(canonical) {
  if (existsSync(canonical)) return canonical;
  const legacy = join(dirname(canonical), basename(canonical).replace(/^panda-force/, "codex-webui"));
  return existsSync(legacy) ? legacy : canonical;
}
