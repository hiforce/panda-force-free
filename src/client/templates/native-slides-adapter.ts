import type { Translate } from "../../shared/i18n/messages.js";
import type { TemplateManagerAdapter } from "./ports.js";
import { nativeSlidesApi as api } from "./native-slides-api.js";
import { PluginApiError } from "../plugins/api.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";

export function nativeSlidesManagerAdapter(t: Translate): TemplateManagerAdapter {
  return {
    registry: "native-slides",
    async load(template) {
      const ref = template.reference;
      if (ref.registry !== "native-slides") throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
      const snapshot = await api.list();
      const detail = snapshot.templates.find(
        (v) => v.id === ref.id && v.version === ref.version && v.digest === ref.digest,
      );
      if (!detail || detail.enabled !== template.state.enabled || detail.active !== template.state.active)
        throw new PluginApiError(409, { messageId: "plugins.registryConflict" });
      const reference = { id: ref.id, version: ref.version, digest: ref.digest };
      return {
        hint: t("templates.officePrivateHint"),
        async overview(host) {
          const content = await api.content(reference),
            section = document.createElement("section");
          section.className = "native-slides-overview";
          setMessageHtml(
            section,
            `<p><strong>${e(content.original.kind.toUpperCase())}</strong> · ${e(t("templates.officeLayouts"))}: ${content.original.layouts.length} · ${e(t("templates.officeSlides"))}: ${content.original.slides.length}</p><p><a class="wb-button" download href="${e(api.originalUrl(reference))}">${e(t("templates.officeOriginal"))}</a></p><h3>${e(t("templates.officeMapping"))}</h3><p>${e(t("templates.officeMappedCount", { count: content.mapping.slots.length }))}</p><ul>${content.mapping.slots.map((slot) => `<li><strong>${e(slot.label)}</strong> <code>${e(slot.id)}</code> · ${e(t(slot.kind === "text" ? "templates.officeText" : "templates.officeImage"))}<br><code>${e(slot.target.part)} #${e(slot.target.shapeId)}</code></li>`).join("")}</ul><details><summary>${e(t("templates.officeSourceIdentity"))}</summary><code>${e(content.original.source.sha256)}</code></details><details><summary>${e(t("templates.nativeReadme"))}</summary><pre>${e(content.readmeText || t("templates.notDeclared"))}</pre></details><details><summary>${e(t("templates.licenseText"))}</summary><pre>${e(content.licenseText)}</pre></details>`,
          );
          host.append(section);
        },
        async export() {
          const url = URL.createObjectURL(await api.export(reference)),
            link = document.createElement("a");
          link.href = url;
          link.download = `${ref.id}-${ref.version}.native-slides.zip`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
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
