import { builtinSiteThemes } from "../../../shared/presentation/themes.js";
import { builtinChannelTemplates } from "../../../shared/presentation/templates.js";
import type { PresentationLabel } from "../../../shared/presentation/labels.js";
import { managedTemplateKey, type ManagedTemplate } from "../../../shared/templates/catalog.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import type { PluginRegistrySnapshot } from "../../../shared/plugins/registry.js";
import type { TemplateCatalogSource } from "../ports.js";

function label(value: PresentationLabel): PresentationLabel {
  const { name, description, labels, nameId, descriptionId } = value;
  return { name, description, labels: labels ? structuredClone(labels) : undefined, nameId, descriptionId };
}
export function builtinTemplateSource(): TemplateCatalogSource {
  const prepared = Promise.all([
    ...builtinSiteThemes.list("markdown").map(async (theme): Promise<ManagedTemplate> => {
      const reference = {
        registry: "builtin" as const,
        kind: "site-theme" as const,
        id: theme.id,
        version: theme.version,
        digest: await contentSha256(JSON.stringify(theme)),
      };
      return {
        key: managedTemplateKey(reference),
        reference,
        templateType: "panda.site-theme",
        categories: ["publishing", "web"],
        label: label(theme),
        publisher: "PandaForce",
        license: "MIT",
        origin: { kind: "builtin" },
        state: { enabled: true, packageEnabled: true, exportEnabled: true, active: true, removed: false },
        compatibility: { engines: [theme.engine], formats: [], outputs: ["web"] },
        actions: {
          editor: null,
          preview: "site-build",
          export: "builtin-copy",
          setEnabled: false,
          activate: false,
        },
      };
    }),
    ...builtinChannelTemplates.list().map(async (template): Promise<ManagedTemplate> => {
      const reference = {
        registry: "builtin" as const,
        kind: "channel-template" as const,
        id: template.id,
        version: template.version,
        digest: await contentSha256(JSON.stringify(template)),
      };
      return {
        key: managedTemplateKey(reference),
        reference,
        templateType: "panda.channel-format",
        categories: ["publishing", "writing"],
        label: label(template),
        publisher: "PandaForce",
        license: "MIT",
        origin: { kind: "builtin" },
        state: { enabled: true, packageEnabled: true, exportEnabled: true, active: true, removed: false },
        compatibility: { engines: [], formats: [...template.formats], outputs: ["document"] },
        actions: {
          editor: "presentation-definition",
          preview: "channel-format",
          export: "builtin-copy",
          setEnabled: false,
          activate: false,
        },
      };
    }),
  ]).then(async (templates) => ({
    registry: "builtin" as const,
    revision: await contentSha256(templates.map((item) => item.key).join("\n")),
    templates,
  }));
  return { registry: "builtin", read: async () => structuredClone(await prepared) };
}
/** The registry is authoritative, including disabled versions; picker catalogs intentionally hide those. */
export function presentationTemplateSource(
  read: () => PluginRegistrySnapshot | Promise<PluginRegistrySnapshot>,
): TemplateCatalogSource {
  return {
    registry: "presentation",
    async read() {
      const snapshot = await read();
      const templates = snapshot.packages.flatMap((pack) =>
        pack.exports.map((entry): ManagedTemplate => {
          const reference = {
            registry: "presentation" as const,
            kind: entry.kind,
            packageId: pack.id,
            exportId: entry.id,
            version: pack.version,
            digest: pack.digest,
          };
          const theme =
            entry.kind === "site-theme" ? pack.manifest.siteThemes.find((item) => item.id === entry.id) : undefined;
          const channel =
            entry.kind === "channel-template"
              ? pack.manifest.channelTemplates.find((item) => item.id === entry.id)
              : undefined;
          if (!theme && !channel) throw Error("Inconsistent native template export");
          return {
            key: managedTemplateKey(reference),
            reference,
            templateType: theme ? "panda.site-theme" : "panda.channel-format",
            categories: theme ? ["publishing", "web"] : ["publishing", "writing"],
            label: label(theme || channel!),
            publisher: null,
            license: null,
            origin: { kind: "installed" },
            state: {
              enabled: pack.enabled && entry.enabled,
              packageEnabled: pack.enabled,
              exportEnabled: entry.enabled,
              active: pack.enabled && entry.enabled && entry.active,
              removed: false,
            },
            compatibility: {
              engines: theme ? [theme.engine] : [],
              formats: channel ? [...channel.formats] : [],
              outputs: theme ? ["web"] : ["document"],
            },
            actions: {
              editor: theme ? null : "presentation-definition",
              preview: theme ? "site-build" : "channel-format",
              export: "presentation-package",
              setEnabled: true,
              activate: pack.enabled && entry.enabled && !entry.active,
            },
          };
        }),
      );
      return { registry: "presentation", revision: String(snapshot.revision), templates };
    },
  };
}
