import { mapMetadata, metadataFailure } from "../../../shared/async-value.js";
import type { SiteThemeMetadataCatalog, ChannelTemplateMetadataCatalog } from "../presentation-ports.js";
import type { PluginRegistryServicePort } from "../service.js";
import type { BuildAuthority, BuildAuthorityPort } from "../../builds/authority.js";
import {
  builtinSiteThemes,
  ThemeSelectionError,
  themeReference,
  type SiteThemeCatalog,
  type SiteThemeDescriptor,
} from "../../../shared/presentation/themes.js";
import {
  builtinChannelTemplates,
  TemplateSelectionError,
  type ChannelTemplateCatalog,
} from "../../../shared/presentation/templates.js";
import { freezeBuildTheme, type BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import { freezeTrustedBuildTheme } from "../../../shared/builds/trusted-theme.js";
import { freezePackageProfile } from "../../../shared/builds/profile-theme.js";
import { isProfileTheme } from "../../../shared/plugins/contracts.js";
import { sameSiteThemeProfile } from "../../../shared/presentation/theme-profile.js";
import type { BuildInput } from "../../../shared/builds/contracts.js";
import { SiteBuildError } from "../../builds/errors.js";
import type { PluginRegistryService } from "../service.js";

/** Composition exposes catalog data, approved bundle capture and dispatch authority as separate ports. */
export interface InstalledPresentation {
  themes: SiteThemeMetadataCatalog;
  templates: ChannelTemplateMetadataCatalog;
  captureTheme(theme: SiteThemeDescriptor): Promise<BuildThemeSnapshot>;
  authorizeBuild: BuildAuthorityPort;
}
export type SynchronousInstalledPresentation = Omit<
  InstalledPresentation,
  "themes" | "templates" | "authorizeBuild"
> & { themes: SiteThemeCatalog; templates: ChannelTemplateCatalog; authorizeBuild: BuildAuthority };
export function installedPresentation(service: PluginRegistryService): SynchronousInstalledPresentation;
export function installedPresentation(service: PluginRegistryServicePort): InstalledPresentation;
export function installedPresentation(service: PluginRegistryServicePort): InstalledPresentation {
  const versions = () =>
    mapMetadata(service.snapshot(), (snapshot) =>
      snapshot.packages
        .filter((item) => item.enabled)
        .sort(
          (a, b) =>
            Number(b.active) - Number(a.active) || a.id.localeCompare(b.id) || a.version.localeCompare(b.version),
        ),
    );
  const themeList = () =>
    mapMetadata(versions(), (versions) =>
      versions.flatMap((installed) =>
        installed.manifest.siteThemes
          .filter((theme) =>
            installed.exports.some((entry) => entry.kind === "site-theme" && entry.id === theme.id && entry.enabled),
          )
          .map((theme): SiteThemeDescriptor => ({
            id: `${installed.id}.${theme.id}`,
            version: installed.version,
            engine: theme.engine,
            name: theme.name,
            description: theme.description,
            labels: theme.labels,
            kind: "installed",
            profile: isProfileTheme(theme) ? structuredClone(theme.profile) : null,
            package: { id: installed.id, version: installed.version, digest: installed.digest },
          })),
      ),
    );
  const themes: SiteThemeMetadataCatalog = {
    list: (engine) =>
      mapMetadata(themeList(), (list) => [
        ...builtinSiteThemes.list(engine),
        ...list.filter((theme) => engine === "markdown" || theme.engine === engine),
      ]),
    validate: (reference, engine) =>
      mapMetadata(themeList(), (list) => {
        const selected = list.find((theme) => themeReference(theme) === reference);
        if (!selected) return builtinSiteThemes.validate(reference, engine);
        if (engine !== "markdown" && selected.engine !== engine) throw new ThemeSelectionError("incompatibleTheme");
        return reference;
      }),
    resolve: (reference, engine) =>
      mapMetadata(themeList(), (list) => {
        const selected = list.find((theme) => themeReference(theme) === reference);
        if (!selected) return builtinSiteThemes.resolve(reference, engine);
        if (selected.engine !== engine) throw new ThemeSelectionError("incompatibleTheme");
        return selected;
      }),
  };
  const templateList = () =>
    mapMetadata(versions(), (versions) =>
      versions.flatMap((installed) =>
        installed.manifest.channelTemplates
          .filter((template) =>
            installed.exports.some(
              (entry) => entry.kind === "channel-template" && entry.id === template.id && entry.enabled,
            ),
          )
          .map((template) => ({
            active: installed.exports.some(
              (entry) => entry.kind === "channel-template" && entry.id === template.id && entry.active,
            ),
            value: {
              id: `${installed.id}.${template.id}`,
              version: installed.version,
              name: template.name,
              description: template.description,
              labels: template.labels,
              formats: template.formats,
              style: { ...template.style, version: installed.version },
            },
          })),
      ),
    );
  const templates: ChannelTemplateMetadataCatalog = {
    list: () =>
      mapMetadata(templateList(), (list) => [...builtinChannelTemplates.list(), ...list.map((entry) => entry.value)]),
    resolve: (id, version) =>
      mapMetadata(templateList(), (list) => {
        const candidates = list.filter((entry) => entry.value.id === id),
          installed = candidates.find((entry) =>
            version === undefined ? entry.active : entry.value.version === version,
          );
        if (installed) return installed.value;
        if (candidates.length)
          throw new TemplateSelectionError(version === undefined ? "unknownTemplate" : "staleTemplate");
        return builtinChannelTemplates.resolve(id, version);
      }),
  };
  async function captureTheme(theme: SiteThemeDescriptor): Promise<BuildThemeSnapshot> {
    if (theme.kind === "builtin") return freezeBuildTheme(theme);
    if (!theme.package) throw new SiteBuildError("themeNotApproved", 403);
    const exportId = theme.id.slice(theme.package.id.length + 1);
    if (theme.id !== `${theme.package.id}.${exportId}`) throw new SiteBuildError("themeNotApproved", 403);
    const bundle = await service.captureExport(theme.package.id, theme.package.version, {
      kind: "site-theme",
      id: exportId,
    });
    if (bundle.digest !== theme.package.digest) throw new SiteBuildError("themeNotApproved", 403);
    const selected = bundle.package.manifest.siteThemes.find((item) => `${theme.package!.id}.${item.id}` === theme.id);
    if (!selected || selected.engine !== theme.engine) throw new SiteBuildError("incompatibleTheme");
    return isProfileTheme(selected)
      ? freezePackageProfile(bundle.package, selected.id)
      : freezeTrustedBuildTheme(bundle.package, selected.id);
  }
  function authorizeBuild(input: BuildInput) {
    return metadataFailure(
      () => {
        const theme = input.theme,
          identity = theme?.package;
        if (!identity) return;
        const exportId = theme.id.slice(identity.id.length + 1);
        if (theme.id !== `${identity.id}.${exportId}`) throw new SiteBuildError("themeNotApproved", 403);
        return mapMetadata(
          service.assertExportEnabled(identity.id, identity.version, identity.digest, {
            kind: "site-theme",
            id: exportId,
          }),
          (installed) => {
            const approved = installed.manifest.siteThemes.find((item) => item.id === exportId);
            if (!approved || approved.engine !== input.engine) throw new SiteBuildError("themeNotApproved", 403);
            if (theme.schema === 1) {
              if (!isProfileTheme(approved) || !sameSiteThemeProfile(approved.profile, theme.profile))
                throw new SiteBuildError("themeNotApproved", 403);
            } else if (theme.exportId !== exportId || isProfileTheme(approved))
              throw new SiteBuildError("themeNotApproved", 403);
          },
        );
      },
      () => {
        throw new SiteBuildError("themeNotApproved", 403);
      },
    );
  }
  return { themes, templates, captureTheme, authorizeBuild };
}
