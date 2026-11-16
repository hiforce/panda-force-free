import {
  PACKAGE_LIMITS,
  PluginPackageError,
  isProfileTheme,
  type PluginPackage,
  type PluginPackageFile,
  type VerifiedPluginPackage,
} from "./contracts.js";
import { validatePluginManifest } from "./manifest.js";
import { canonicalPackageJson, packagePath, packageRecord, packageSha256 } from "./validation.js";

const extension =
  /\.(?:js|cjs|mjs|jsx|ts|tsx|ejs|pug|njk|html|css|json|ya?ml|md|txt|svg|png|jpe?g|webp|gif|avif|woff2?)$/i;
const executable = /\.(?:js|cjs|mjs|jsx|ts|tsx|ejs|pug|njk|html)$/i;

function file(value: unknown): { file: PluginPackageFile; size: number } {
  const input = packageRecord(value, ["path", "data", "sha256"]),
    path = packagePath(input.path);
  if (!extension.test(path)) throw new PluginPackageError("invalidPackagePath");
  if (typeof input.data !== "string" || input.data.length > Math.ceil(PACKAGE_LIMITS.fileBytes / 3) * 4)
    throw new PluginPackageError("packageTooLarge");
  const padding = input.data.indexOf("=");
  if (
    input.data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(input.data) ||
    (padding >= 0 && (padding < input.data.length - 2 || !/^={1,2}$/.test(input.data.slice(padding)))) ||
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    throw new PluginPackageError("invalidPackage");
  const decoded = atob(input.data);
  if (btoa(decoded) !== input.data) throw new PluginPackageError("invalidPackage");
  if (decoded.length > PACKAGE_LIMITS.fileBytes) throw new PluginPackageError("packageTooLarge");
  return { file: { path, data: input.data, sha256: input.sha256 }, size: decoded.length };
}

/** Installation is data intake, never import(), npm install, archive extraction or a shell command. */
export function normalizePluginPackage(value: unknown): Omit<VerifiedPluginPackage, "digest"> {
  const input = packageRecord(value, ["schema", "manifest", "files"]);
  if (input.schema !== 1 || !Array.isArray(input.files)) throw new PluginPackageError("invalidPackage");
  if (input.files.length > PACKAGE_LIMITS.files) throw new PluginPackageError("packageTooLarge");
  const manifest = validatePluginManifest(input.manifest),
    files: PluginPackageFile[] = [],
    paths = new Set<string>(),
    spellings = new Map<string, string>();
  let byteLength = 0;
  // Process sequentially so a malicious package cannot allocate all decoded files at once.
  for (const item of input.files) {
    const parsed = file(item),
      key = parsed.file.path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new PluginPackageError("invalidPackagePath");
    paths.add(key);
    const parts = parsed.file.path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join("/"),
        folded = spelling.normalize("NFC").toLowerCase(),
        prior = spellings.get(folded);
      if (prior !== undefined && prior !== spelling) throw new PluginPackageError("invalidPackagePath");
      spellings.set(folded, spelling);
    }
    byteLength += parsed.size;
    if (byteLength > PACKAGE_LIMITS.totalBytes) throw new PluginPackageError("packageTooLarge");
    if (!manifest.siteThemes.some((theme) => !isProfileTheme(theme) && parsed.file.path.startsWith(theme.root + "/")))
      throw new PluginPackageError("invalidPackagePath");
    files.push(parsed.file);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join("/"))) throw new PluginPackageError("invalidPackagePath");
  }
  for (const theme of manifest.siteThemes) {
    if (isProfileTheme(theme)) continue;
    if (!files.some((item) => item.path.startsWith(theme.root + "/"))) throw new PluginPackageError("invalidPackage");
    if (theme.engine === "hexo") {
      if (!files.some((item) => item.path.startsWith(theme.root + "/layout/") && /\.(?:ejs|pug|njk)$/.test(item.path)))
        throw new PluginPackageError("invalidPackage");
    } else if (!files.some((item) => item.path === `${theme.root}/${theme.entry}`))
      throw new PluginPackageError("invalidPackage");
  }
  if (files.some((item) => executable.test(item.path)) && !manifest.permissions.includes("build:theme-code"))
    throw new PluginPackageError("permissionMismatch");
  const packageValue: PluginPackage = {
    schema: 1,
    manifest,
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return {
    package: packageValue,
    fileCount: files.length,
    byteLength,
  };
}

export async function verifyPluginPackage(value: unknown): Promise<VerifiedPluginPackage> {
  const normalized = normalizePluginPackage(value);
  for (const file of normalized.package.files) {
    const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
    if ((await packageSha256(bytes)) !== file.sha256) throw new PluginPackageError("packageDigestMismatch");
  }
  return { ...normalized, digest: await packageSha256(canonicalPackageJson(normalized.package)) };
}

/** Bound text input before parsing JSON; callers must also bound their HTTP body readers. */
export async function parsePluginPackage(text: string): Promise<VerifiedPluginPackage> {
  if (
    typeof text !== "string" ||
    text.length > PACKAGE_LIMITS.jsonBytes ||
    new TextEncoder().encode(text).length > PACKAGE_LIMITS.jsonBytes
  )
    throw new PluginPackageError("packageTooLarge");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PluginPackageError("invalidPackage");
  }
  return verifyPluginPackage(value);
}
