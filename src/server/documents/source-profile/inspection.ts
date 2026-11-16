import { readdir } from "node:fs/promises";
import {
  publicConfigKeys,
  publicSiteConfig,
  privateConfigKey,
  type PublicValue,
} from "../../../shared/sites/config.js";
import { siteEdition, type SiteEdition } from "../../../shared/sites/profile.js";
import { readSourceText } from "../ingestion/files.js";
import { sourceYaml } from "./yaml.js";
import { DocumentError } from "../errors.js";

export async function sourceConfigurationOptions(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^_config(?:\.[a-z0-9_-]+)?\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length > 32) throw new DocumentError("tooLarge", 413);
  const themes: string[] = [];
  try {
    for (const entry of await readdir(root + "/themes", { withFileTypes: true }))
      if (entry.isDirectory() && !entry.name.startsWith(".")) themes.push(entry.name);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return {
    files,
    themes: themes.sort(),
    assets: entries.some((entry) => entry.name === "assets" && entry.isDirectory()),
  };
}
function merge(left: Record<string, unknown>, right: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 8) throw new DocumentError("invalidSourceConfiguration");
  return Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => {
      const a = left[key],
        b = right[key];
      return [
        key,
        b === undefined
          ? a
          : a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)
            ? merge(a as Record<string, unknown>, b as Record<string, unknown>, depth + 1)
            : b,
      ];
    }),
  );
}
/** Import only the public projection; operational options and private values never enter the proposal. */
export async function inspectSourceConfiguration(
  root: string,
  files: string[],
): Promise<{ edition: SiteEdition; omitted: string[] }> {
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 8 ||
    new Set(files).size !== files.length ||
    files.some((name) => typeof name !== "string" || !/^_config(?:\.[a-z0-9_-]+)?\.ya?ml$/i.test(name))
  )
    throw new DocumentError("invalidInput");
  let input: Record<string, unknown> = {};
  for (const path of files) input = merge(input, sourceYaml(await readSourceText(root, path, 64 * 1024)));
  const omitted: string[] = [];
  function clean(value: unknown, path: string, depth = 0): unknown {
    if (depth > 8) throw new DocumentError("invalidSourceConfiguration");
    if (Array.isArray(value)) return value.map((item, index) => clean(item, `${path}.${index}`, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => {
            if (privateConfigKey(key)) {
              omitted.push(`${path}.${key}`);
              return false;
            }
            return true;
          })
          .map(([key, item]) => [key, clean(item, `${path}.${key}`, depth + 1)]),
      );
    return value;
  }
  const config: Record<string, PublicValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(publicConfigKeys as readonly string[]).includes(key)) {
      if (!["title", "url", "root", "language"].includes(key)) omitted.push(key);
      continue;
    }
    config[key] = clean(value, key) as PublicValue;
  }
  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new DocumentError("invalidSourceConfiguration");
  }
  if (url.username || url.password || url.search || url.hash) throw new DocumentError("invalidSourceConfiguration");
  return {
    edition: siteEdition({
      title: input.title,
      url: url.origin,
      basePath: input.root || "/",
      config: publicSiteConfig(config),
    }),
    omitted: omitted.slice(0, 200),
  };
}
