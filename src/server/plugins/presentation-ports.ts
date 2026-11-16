import type { SiteThemeCatalog } from "../../shared/presentation/themes.js";
import type { ChannelTemplateCatalog } from "../../shared/presentation/templates.js";
import type { MetadataStore } from "../../shared/async-value.js";
export type SiteThemeMetadataCatalog = MetadataStore<SiteThemeCatalog>;
export type ChannelTemplateMetadataCatalog = MetadataStore<ChannelTemplateCatalog>;
