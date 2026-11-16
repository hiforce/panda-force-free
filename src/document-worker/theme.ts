import type { BuildInput } from "../shared/builds/contracts.js";

/** Profiles contain validated values only; arbitrary theme scripts are not part of this renderer. */
export function siteThemeCss(input: BuildInput): string {
  const profile = input.theme?.schema === 1 ? input.theme.profile : null;
  if (!profile) return "";
  const font = profile.font === "serif" ? "Georgia,Charter,serif" : "system-ui,-apple-system,sans-serif";
  if (input.engine === "docusaurus")
    return `:root{--ifm-color-primary:${profile.accent};--ifm-font-family-base:${font};--ifm-container-width:${profile.width}px;--ifm-container-width-xl:${profile.width}px;--ifm-line-height-base:${profile.density === "compact" ? 1.55 : 1.8}}.markdown{font-size:${profile.density === "compact" ? 15 : 16}px}.markdown h1{letter-spacing:-.03em}.theme-doc-sidebar-container{font-size:14px}`;
  return `:root{font-family:${font}}header,main,footer{max-width:${profile.width}px}a{color:${profile.accent}}blockquote{border-color:${profile.accent}}${profile.layout === "journal" ? "header{text-transform:uppercase;letter-spacing:.12em;font-size:13px}article{padding:36px 0}h1,h2{font-family:Georgia,serif}footer{font-family:system-ui,sans-serif}.panda-abstract{padding:20px 24px;background:#f8f6f2;border-radius:8px}" : ""}`;
}
