import { validateSiteThemeProfile } from "../../presentation/theme-profile.js";
import type { PortableTemplateTypeAdapter } from "./contracts.js";
import { templateChoice, templateObject } from "../portable/validation.js";

export const siteProfileTemplateAdapter: PortableTemplateTypeAdapter = Object.freeze<PortableTemplateTypeAdapter>({
  templateType: "panda.site-theme",
  format: "panda.site-profile/v1",
  adapter: { id: "panda.site-builds", api: 1 },
  parse(value) {
    const input = templateObject(value, ["engine", "profile"]),
      engine = templateChoice(input.engine, ["hexo", "docusaurus"]);
    return { kind: "site", engine, profile: validateSiteThemeProfile(input.profile, engine) };
  },
});
