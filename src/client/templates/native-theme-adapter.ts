import type { Translate } from "../../shared/i18n/messages.js";
import type { TemplateManagerAdapter } from "./ports.js";
import { PluginApiError } from "../plugins/api.js";
import { nativeThemeApi as api } from "./native-theme-api.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import { portableSourceLabel } from "./source-labels.js";
import { createBuildSampleMonitor } from "../site-samples/monitor.js";
import { nativeSampleApi } from "./native-sample-api.js";

export function nativeThemeManagerAdapter(t: Translate): TemplateManagerAdapter {
  return {
    registry: "native",
    async load(template) {
      const ref = template.reference;
      if (ref.registry !== "native") throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
      const snapshot = await api.list(),
        detail = snapshot.themes.find(
          (value) => value.id === ref.id && value.version === ref.version && value.digest === ref.digest,
        );
      if (!detail || detail.enabled !== template.state.enabled || detail.active !== template.state.active)
        throw new PluginApiError(409, { messageId: "plugins.registryConflict" });
      const reference = { id: ref.id, version: ref.version, digest: ref.digest };
      const monitor = createBuildSampleMonitor(t, nativeSampleApi, { canStart: () => detail.enabled });
      return {
        hint: t("templates.nativePrivateHint"),
        preview: (host) => monitor.mount(host, reference),
        clearPreview: () => monitor.clear(),
        async export() {
          const url = URL.createObjectURL(await api.export(reference)),
            link = document.createElement("a");
          link.href = url;
          link.download = `${ref.id}-${ref.version}.native-theme.zip`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        async overview(target) {
          const content = await api.content(reference),
            section = document.createElement("section");
          section.className = "native-theme-overview";
          const origin = {
            kind: "captured" as const,
            sha256: detail.source.digest,
            root: detail.root,
            source: detail.source.origin,
          };
          setMessageHtml(
            section,
            `<p><code>${e(portableSourceLabel(origin))}</code></p><details><summary>${e(t("templates.nativeReadme"))}</summary><pre>${e(content.readmeText || t("templates.notDeclared"))}</pre></details><details><summary>${e(t("templates.licenseText"))}</summary><pre>${e(content.licenseText)}</pre></details><details><summary>${e(t("templates.nativeDependencies"))}</summary><pre>${e(JSON.stringify(detail.settings.dependencies, null, 2))}</pre><p>${e(t("templates.nativeDependenciesHint"))}</p></details>`,
          );
          const exportHint = document.createElement("p");
          exportHint.textContent = t("templates.nativeExportHint");
          section.append(exportHint);
          target.append(section);
        },
        async setEnabled(enabled) {
          await api.state(reference, enabled ? "enable" : "disable", snapshot.revision);
        },
        async activate() {
          await api.state(reference, "activate", snapshot.revision);
        },
      };
    },
  };
}
