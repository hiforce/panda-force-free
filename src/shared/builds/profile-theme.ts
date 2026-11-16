import type { PluginPackage } from "../plugins/contracts.js";
import { isProfileTheme } from "../plugins/contracts.js";
import { verifyPluginPackage } from "../plugins/package.js";
import { freezeDeclarativeBuildTheme } from "./theme.js";
import { BuildThemeError } from "./theme-errors.js";

/** Freeze only a verified closed profile export; executable package files never enter this snapshot. */
export async function freezePackageProfile(bundle: PluginPackage, exportId: string) {
  const verified = await verifyPluginPackage(bundle),
    { manifest } = verified.package;
  const theme = manifest.siteThemes.find((item) => item.id === exportId);
  if (!theme || !isProfileTheme(theme)) throw new BuildThemeError("invalidTheme");
  return freezeDeclarativeBuildTheme({
    schema: 1,
    id: manifest.id + "." + theme.id,
    version: manifest.version,
    engine: theme.engine,
    profile: theme.profile,
    package: { id: manifest.id, version: manifest.version, digest: verified.digest },
  });
}
