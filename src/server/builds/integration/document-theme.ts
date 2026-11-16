import type { MetadataStore } from "../../../shared/async-value.js";
import { freezeBuildTheme, type BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import type { BuildEngine } from "../../../shared/builds/contracts.js";
import {
  ThemeSelectionError,
  themeReference,
  type SiteThemeCatalog,
  type SiteThemeDescriptor,
} from "../../../shared/presentation/themes.js";
import { SiteBuildError } from "../errors.js";

export async function documentBuildTheme(
  reference: string,
  engine: BuildEngine,
  themes: MetadataStore<SiteThemeCatalog>,
  capture: (theme: SiteThemeDescriptor) => Promise<BuildThemeSnapshot> = freezeBuildTheme,
) {
  try {
    const selected = await themes.resolve(reference, engine);
    if (reference !== "default" && themeReference(selected) !== reference)
      throw new ThemeSelectionError("unknownTheme");
    return await capture(selected);
  } catch (error) {
    if (error instanceof ThemeSelectionError) throw new SiteBuildError(error.code);
    throw error;
  }
}
