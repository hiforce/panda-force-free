import type { Translate } from "../../shared/i18n/messages.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { builtinSiteThemes } from "../../shared/presentation/themes.js";
import { builtinChannelTemplates } from "../../shared/presentation/templates.js";
import { isProfileTheme, type PluginPackage } from "../../shared/plugins/contracts.js";
import { pluginApi, PluginApiError } from "../plugins/api.js";
import {
  copyChannelTemplate,
  copySiteTheme,
  nextPackageDraft,
  type PublishingStyle,
} from "../publishing-styles/catalog.js";
import { channelSamplePreview, siteSamplePreview } from "../publishing-styles/preview.js";
import { styleSample } from "../publishing-styles/api.js";
import { createSiteSampleMonitor } from "../site-samples/controller.js";
import { downloadTemplate } from "./api.js";
import { publicationFormatLabels } from "../publication-format-labels.js";
import type { TemplateManagerAdapter, ManagedTemplateDetail } from "./ports.js";

export function presentationManagerAdapters(
  t: Translate,
  edit: (value: PluginPackage) => Promise<() => void>,
): TemplateManagerAdapter[] {
  async function load(template: ManagedTemplate): Promise<ManagedTemplateDetail> {
    const ref = template.reference;
    if (ref.registry !== "builtin" && ref.registry !== "presentation")
      throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
    let style: PublishingStyle, value: PluginPackage;
    const snapshot = await pluginApi.list();
    if (ref.registry === "builtin") {
      style =
        ref.kind === "site-theme"
          ? {
              kind: "site",
              value: builtinSiteThemes
                .list("markdown")
                .find((item) => item.id === ref.id && item.version === ref.version)!,
            }
          : { kind: "channel", value: builtinChannelTemplates.resolve(ref.id, ref.version) };
      if (!style.value) throw new PluginApiError(404, { messageId: "plugins.packageUnavailable" });
      value = style.kind === "site" ? copySiteTheme(style.value, t) : copyChannelTemplate(style.value, t);
    } else {
      const installed = snapshot.packages.find(
        (item) => item.id === ref.packageId && item.version === ref.version && item.digest === ref.digest,
      );
      if (!installed) throw new PluginApiError(409, { messageId: "plugins.reviewChanged" });
      value = await pluginApi.export(ref.packageId, ref.version);
      const theme = value.manifest.siteThemes.find((item) => item.id === ref.exportId);
      const channel = value.manifest.channelTemplates.find((item) => item.id === ref.exportId);
      if (ref.kind === "site-theme" && theme)
        style = {
          kind: "site",
          value: {
            ...theme,
            id: `${ref.packageId}.${ref.exportId}`,
            version: ref.version,
            kind: "installed",
            profile: isProfileTheme(theme) ? theme.profile : null,
            package: { id: ref.packageId, version: ref.version, digest: ref.digest },
          },
        };
      else if (ref.kind === "channel-template" && channel)
        style = {
          kind: "channel",
          value: {
            ...channel,
            id: `${ref.packageId}.${ref.exportId}`,
            version: ref.version,
            style: { ...channel.style, version: ref.version },
          },
        };
      else throw new PluginApiError(404, { messageId: "plugins.exportUnavailable" });
    }
    const monitor =
      style.kind === "site"
        ? createSiteSampleMonitor(t, {
            illustration: (host) => {
              if (style.kind === "site") siteSamplePreview(host, style.value, t);
            },
          })
        : null;
    return {
      hint: t("templates.pinnedHint"),
      async preview(host) {
        if (!template.state.enabled) {
          host.textContent = t("templates.disabledPreview");
          return;
        }
        const note = document.createElement("p");
        note.textContent = t(style.kind === "site" ? "plugins.stylesSiteSample" : "plugins.stylesChannelSample");
        if (style.kind === "site") {
          const output = document.createElement("div");
          host.replaceChildren(note, output);
          await monitor!.mount(output, {
            kind: "catalog",
            engine: style.value.engine,
            reference: `${style.value.id}@${style.value.version}`,
          });
        } else {
          const selector = document.createElement("select"),
            output = document.createElement("div"),
            label = document.createElement("label");
          label.textContent = t("publishing.format");
          label.append(selector);
          host.replaceChildren(note, label, output);
          for (const format of style.value.formats)
            selector.add(new Option(t(publicationFormatLabels[format]), format));
          let request = 0;
          const render = async () => {
            const generation = ++request;
            const sample = await styleSample(style.value, selector.value as (typeof style.value.formats)[number]);
            if (generation === request && host.isConnected) channelSamplePreview(output, sample, t);
          };
          selector.onchange = () =>
            void render().catch(() => {
              output.textContent = t("plugins.packageUnavailable");
            });
          await render();
        }
      },
      clearPreview: () => monitor?.clear(),
      ...(style.kind === "channel"
        ? {
            async edit() {
              const versions = snapshot.packages
                .filter((item) => item.id === value.manifest.id)
                .map((item) => item.version);
              const draft = ref.registry === "builtin" && !versions.length ? value : nextPackageDraft(value, versions);
              if (!draft) throw new PluginApiError(409, { messageId: "plugins.immutableVersion" });
              return edit(draft);
            },
          }
        : {}),
      async export() {
        downloadTemplate(value, `${value.manifest.id}-${value.manifest.version}.json`);
      },
      ...(ref.registry === "presentation"
        ? {
            async setEnabled(enabled: boolean) {
              await pluginApi.exportState(
                ref.packageId,
                ref.version,
                { kind: ref.kind, id: ref.exportId },
                enabled,
                snapshot.revision,
              );
            },
            async activate() {
              await pluginApi.activateExport(
                ref.packageId,
                ref.version,
                { kind: ref.kind, id: ref.exportId },
                snapshot.revision,
              );
            },
          }
        : {}),
    };
  }
  return [
    { registry: "builtin", load },
    { registry: "presentation", load },
  ];
}
