import type { SiteThemeDescriptor, SiteThemeProfile } from "../presentation/themes.js";
import { validateSiteThemeProfile } from "../presentation/theme-profile.js";
import type { BuildEngine } from "./engines.js";
import { BuildThemeError } from "./theme-errors.js";
import { profilePackageIdentity, type ProfilePackageIdentity } from "./profile-identity.js";
import { validateTrustedBuildTheme, verifyTrustedBuildTheme, type TrustedBuildThemeSnapshot } from "./trusted-theme.js";
export { BuildThemeError } from "./theme-errors.js";

export interface DeclarativeBuildThemeSnapshot {
  schema: 1;
  id: string;
  version: string;
  engine: BuildEngine;
  profile: SiteThemeProfile;
  package?: ProfilePackageIdentity;
  sha256: string;
}
export type BuildThemeSnapshot = DeclarativeBuildThemeSnapshot | TrustedBuildThemeSnapshot;
export type BuildThemeMetadata = DeclarativeBuildThemeSnapshot | Omit<TrustedBuildThemeSnapshot, "bundle">;
export function buildThemeMetadata(value: BuildThemeSnapshot): BuildThemeMetadata {
  if (value.schema === 1) return structuredClone(value);
  const { bundle: _bundle, ...metadata } = value;
  return structuredClone(metadata);
}
export const THEME_PROTOCOL = "site-themes/v1";
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new BuildThemeError("invalidTheme");
  return value as Record<string, unknown>;
}
async function checksum(value: Omit<DeclarativeBuildThemeSnapshot, "sha256">) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function freezeDeclarativeBuildTheme(
  value: Omit<DeclarativeBuildThemeSnapshot, "sha256">,
): Promise<DeclarativeBuildThemeSnapshot> {
  const parsed = validateBuildTheme({ ...value, sha256: "0".repeat(64) }, value.engine);
  if (parsed.schema !== 1) throw new BuildThemeError("invalidTheme");
  const { sha256: _sha256, ...data } = parsed;
  return { ...data, sha256: await checksum(data) };
}
export async function freezeBuildTheme(theme: SiteThemeDescriptor): Promise<DeclarativeBuildThemeSnapshot> {
  if (theme.kind !== "builtin" || !theme.profile || theme.package) throw new BuildThemeError("trustedThemeRequired");
  return freezeDeclarativeBuildTheme({
    schema: 1,
    id: theme.id,
    version: theme.version,
    engine: theme.engine,
    profile: theme.profile,
  });
}
/** Closed profiles carry no CSS, code or paths. Package provenance participates in the frozen input digest. */
export function validateBuildTheme(value: unknown, engine: BuildEngine): BuildThemeSnapshot {
  if (value && typeof value === "object" && "schema" in value && value.schema === 2)
    return validateTrustedBuildTheme(value, engine);
  const input = record(value, ["schema", "id", "version", "engine", "profile", "package", "sha256"]);
  if (
    input.schema !== 1 ||
    input.engine !== engine ||
    typeof input.id !== "string" ||
    !/^[a-z][a-z0-9.-]{1,63}$/.test(input.id) ||
    typeof input.version !== "string" ||
    !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.version) ||
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    throw new BuildThemeError("invalidTheme");
  let profile: SiteThemeProfile;
  try {
    profile = validateSiteThemeProfile(input.profile, engine);
  } catch {
    throw new BuildThemeError("invalidTheme");
  }
  const identity = input.package === undefined ? undefined : profilePackageIdentity(input.package);
  if (identity && (identity.version !== input.version || !input.id.startsWith(identity.id + ".")))
    throw new BuildThemeError("invalidTheme");
  return {
    schema: 1,
    id: input.id,
    version: input.version,
    engine,
    profile,
    ...(identity ? { package: identity } : {}),
    sha256: input.sha256,
  };
}
/** Runtime adapters verify content identity before storing or executing a snapshot. */
export async function verifyBuildTheme(value: unknown, engine: BuildEngine) {
  const parsed = validateBuildTheme(value, engine);
  if (parsed.schema === 2) return verifyTrustedBuildTheme(parsed, engine);
  const { sha256, ...data } = parsed;
  if (sha256 !== (await checksum(data))) throw new BuildThemeError("themeDigestMismatch");
  return parsed;
}
