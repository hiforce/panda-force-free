import { packageId, packageVersion, packageRecord } from "../plugins/validation.js";
import { BuildThemeError } from "./theme-errors.js";

export const PROFILE_THEME_PROTOCOL = "profile-theme-packages/v1";
export interface ProfilePackageIdentity {
  id: string;
  version: string;
  digest: string;
}
export function profilePackageIdentity(value: unknown): ProfilePackageIdentity {
  try {
    const input = packageRecord(value, ["id", "version", "digest"]);
    if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))
      throw new BuildThemeError("invalidTheme");
    return { id: packageId(input.id), version: packageVersion(input.version), digest: input.digest };
  } catch {
    throw new BuildThemeError("invalidTheme");
  }
}
