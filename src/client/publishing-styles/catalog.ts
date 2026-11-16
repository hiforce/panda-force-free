import type { SiteThemeDescriptor } from "../../shared/presentation/themes.js";
import type { ChannelTemplateDescriptor } from "../../shared/presentation/templates.js";
import type { PluginRegistrySnapshot, InstalledPlugin } from "../../shared/plugins/registry.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import { presentationLabel } from "../presentation-labels.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { PublicationFormat } from "../../shared/publishing/content.js";
import { builtinChannelTemplates } from "../../shared/presentation/templates.js";

export type PublishingStyle =
  { kind: "site"; value: SiteThemeDescriptor } | { kind: "channel"; value: ChannelTemplateDescriptor };
export const styleReference = (style: PublishingStyle) => `${style.value.id}@${style.value.version}`;
export const styleKey = (style: PublishingStyle) => `${style.kind}:${styleReference(style)}`;
export const isBuiltinStyle = (style: PublishingStyle) =>
  style.kind === "site"
    ? style.value.kind === "builtin"
    : builtinChannelTemplates.list().some((item) => item.id === style.value.id && item.version === style.value.version);

/** Drafts start above retained versions; existing package bytes and selected project versions stay immutable. */
export function nextPackageDraft(value: PluginPackage, versions: string[]): PluginPackage | null {
  const highest = [value.manifest.version, ...versions]
    .map((version) => version.split(".").map(Number))
    .sort((a, b) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!)[0]!;
  for (let index = 2; index >= 0; index--) {
    if (highest[index]! >= 9999) continue;
    highest[index] = highest[index]! + 1;
    for (let trailing = index + 1; trailing < 3; trailing++) highest[trailing] = 0;
    const draft = structuredClone(value);
    draft.manifest.version = highest.join(".");
    return draft;
  }
  return null;
}
export function stylePackage(style: PublishingStyle, registry: PluginRegistrySnapshot): InstalledPlugin | undefined {
  return registry.packages.find(
    (entry) =>
      entry.version === style.value.version &&
      (style.kind === "site" ? entry.manifest.siteThemes : entry.manifest.channelTemplates).some(
        (item) => `${entry.id}.${item.id}` === style.value.id,
      ),
  );
}
export function styleMatches(style: PublishingStyle, query: string, engine: string, t: Translate) {
  return (
    (engine === "all" ||
      (style.kind === "site"
        ? style.value.engine === engine
        : style.value.formats.includes(engine as PublicationFormat))) &&
    [
      style.value.id,
      style.value.version,
      presentationLabel(t, style.value),
      presentationLabel(t, style.value, "description"),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  );
}
/** A copy starts a new immutable package lineage; it never edits the built-in template. */
export function copyChannelTemplate(value: ChannelTemplateDescriptor, t: Translate): PluginPackage {
  const { version: _version, ...style } = value.style;
  return {
    schema: 1,
    manifest: {
      schema: 1,
      id: "custom." + value.id.replace(/^panda\./, "").slice(0, 32),
      version: "1.0.0",
      name: presentationLabel(t, value),
      description: presentationLabel(t, value, "description"),
      permissions: ["content:templates"],
      siteThemes: [],
      channelTemplates: [
        { id: "style", name: presentationLabel(t, value), description: "", formats: [...value.formats].sort(), style },
      ],
    },
    files: [],
  };
}

/** Built-in visual profiles become data-only packages; custom code is never inferred from a thumbnail. */
export function copySiteTheme(value: SiteThemeDescriptor, t: Translate): PluginPackage {
  if (value.kind !== "builtin" || !value.profile) throw Error("A built-in site profile is required");
  return {
    schema: 1,
    manifest: {
      schema: 1,
      id: "custom." + value.id.replace(/^panda\./, "").slice(0, 32),
      version: "1.0.0",
      name: presentationLabel(t, value),
      description: presentationLabel(t, value, "description"),
      permissions: ["content:site-themes"],
      siteThemes: [
        {
          kind: "profile",
          id: "style",
          name: presentationLabel(t, value),
          description: "",
          engine: value.engine,
          profile: structuredClone(value.profile),
        },
      ],
      channelTemplates: [],
    },
    files: [],
  };
}
