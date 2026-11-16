import type { BuildEngine } from "./engines.js";
import { BuildThemeError } from "./theme-errors.js";
import type { PluginPackage, VerifiedPluginPackage, PackageCodeTheme } from "../plugins/contracts.js";
import { isProfileTheme } from "../plugins/contracts.js";
import { normalizePluginPackage, verifyPluginPackage } from "../plugins/package.js";
import { canonicalPackageJson, packageRecord, packageSha256 } from "../plugins/validation.js";

export const TRUSTED_THEME_PROTOCOL = "trusted-themes/v1";
export interface TrustedBuildThemeSnapshot {
  schema: 2;
  id: string;
  version: string;
  engine: BuildEngine;
  package: { id: string; version: string; digest: string };
  exportId: string;
  bundle: PluginPackage;
  sha256: string;
}
/** Workers consume the verified build protocol, never the general package registry contract. */
export function trustedThemeExport(snapshot: TrustedBuildThemeSnapshot): Readonly<PackageCodeTheme> {
  const theme = snapshot.bundle.manifest.siteThemes.find((item) => item.id === snapshot.exportId);
  if (!theme || isProfileTheme(theme) || theme.engine !== snapshot.engine) throw new BuildThemeError("invalidTheme");
  return theme;
}
function fromBundle(verified: VerifiedPluginPackage, exportId: string): Omit<TrustedBuildThemeSnapshot, "sha256"> {
  const { manifest } = verified.package,
    theme = manifest.siteThemes.find((item) => item.id === exportId);
  if (!theme || isProfileTheme(theme)) throw new BuildThemeError("invalidTheme");
  return {
    schema: 2,
    id: `${manifest.id}.${theme.id}`,
    version: manifest.version,
    engine: theme.engine,
    package: { id: manifest.id, version: manifest.version, digest: verified.digest },
    exportId,
    bundle: verified.package,
  };
}
export async function freezeTrustedBuildTheme(
  bundle: PluginPackage,
  exportId: string,
): Promise<TrustedBuildThemeSnapshot> {
  const verified = await verifyPluginPackage(bundle),
    snapshot = fromBundle(verified, exportId);
  return { ...snapshot, sha256: await packageSha256(canonicalPackageJson(snapshot)) };
}
/** Synchronous shape normalization does not substitute for content verification at execution boundaries. */
export function validateTrustedBuildTheme(value: unknown, engine: BuildEngine): TrustedBuildThemeSnapshot {
  try {
    const input = packageRecord(value, [
        "schema",
        "id",
        "version",
        "engine",
        "package",
        "exportId",
        "bundle",
        "sha256",
      ]),
      identity = packageRecord(input.package, ["id", "version", "digest"]),
      bundle = normalizePluginPackage(input.bundle),
      { manifest } = bundle.package;
    if (
      input.schema !== 2 ||
      typeof input.exportId !== "string" ||
      typeof identity.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(identity.digest) ||
      input.id !== `${manifest.id}.${input.exportId}` ||
      input.version !== manifest.version ||
      identity.id !== manifest.id ||
      identity.version !== manifest.version ||
      input.engine !== engine ||
      !manifest.siteThemes.some((item) => item.id === input.exportId && item.engine === engine) ||
      typeof input.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.sha256)
    )
      throw new BuildThemeError("invalidTheme");
    return { ...fromBundle({ ...bundle, digest: identity.digest }, input.exportId), sha256: input.sha256 };
  } catch (error) {
    if (error instanceof BuildThemeError) throw error;
    throw new BuildThemeError("invalidTheme");
  }
}
export async function verifyTrustedBuildTheme(value: unknown, engine: BuildEngine): Promise<TrustedBuildThemeSnapshot> {
  const parsed = validateTrustedBuildTheme(value, engine);
  try {
    const verified = await verifyPluginPackage(parsed.bundle),
      { sha256, ...snapshot } = parsed;
    if (verified.digest !== parsed.package.digest || (await packageSha256(canonicalPackageJson(snapshot))) !== sha256)
      throw new BuildThemeError("themeDigestMismatch");
    return parsed;
  } catch {
    throw new BuildThemeError("themeDigestMismatch");
  }
}
