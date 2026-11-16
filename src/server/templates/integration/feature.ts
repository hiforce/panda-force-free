import { TemplateCatalog } from "../catalog.js";
import { builtinTemplateSource, presentationTemplateSource } from "./presentation-source.js";
import { skillTemplateSource } from "./skill-source.js";
import { templateCatalogRoutes } from "./routes.js";
import type { PluginRegistrySnapshot } from "../../../shared/plugins/registry.js";
import type { SkillRegistryPage } from "../../../shared/skills/registry.js";
import type { RouteContext } from "../../http/router.js";
import type { PortableRegistrySnapshot } from "../../../shared/templates/portable/registry.js";
import { portableTemplateSource } from "./portable-source.js";
import { nativeThemeCatalogSource } from "./native-catalog.js";
import type { NativeThemeSnapshot } from "../../../shared/templates/native/contracts.js";
import type { NativeSlidesSnapshot } from "../../../shared/slides/registry.js";
import { nativeSlidesCatalogSource } from "./native-slides-catalog.js";

export function createTemplateCatalogFeature(options: {
  presentation(): PluginRegistrySnapshot | Promise<PluginRegistrySnapshot>;
  skills(cursor?: string, limit?: number): SkillRegistryPage | Promise<SkillRegistryPage>;
  owner(context: RouteContext): string;
  portable?(): PortableRegistrySnapshot | Promise<PortableRegistrySnapshot>;
  native?(actor: string): NativeThemeSnapshot | Promise<NativeThemeSnapshot>;
  nativeSlides?(actor: string): NativeSlidesSnapshot | Promise<NativeSlidesSnapshot>;
  collection?: Parameters<typeof templateCatalogRoutes>[2];
}) {
  const catalog = new TemplateCatalog([
    builtinTemplateSource(),
    presentationTemplateSource(options.presentation),
    skillTemplateSource(options.skills),
    ...(options.portable ? [portableTemplateSource(options.portable)] : []),
    ...(options.native ? [nativeThemeCatalogSource(options.native)] : []),
    ...(options.nativeSlides ? [nativeSlidesCatalogSource(options.nativeSlides)] : []),
  ]);
  return { catalog, routes: templateCatalogRoutes(catalog, options.owner, options.collection) };
}
