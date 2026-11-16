import type { Translate } from "../../shared/i18n/messages.js";
import type { TemplateManagerAdapter, TemplateDetailPreviewRuntime } from "./ports.js";
import { PluginApiError } from "../plugins/api.js";
import { downloadTemplate } from "./api.js";
import { portableTemplatesApi as api } from "./portable-api.js";
import type { TemplateNativeReference } from "../../shared/templates/catalog.js";
import { templatePreviewImages } from "./preview-images.js";

export function portableTemplateManagerAdapter(
  t: Translate,
  fork: ((reference: TemplateNativeReference) => Promise<() => void>) | undefined,
  previews: () => Promise<TemplateDetailPreviewRuntime>,
): TemplateManagerAdapter {
  return {
    registry: "portable",
    async load(template) {
      const ref = template.reference;
      if (ref.registry !== "portable") throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
      const query = new URLSearchParams({ id: ref.id, version: ref.version, digest: ref.digest }),
        detail = await api.detail(query);
      return {
        hint: t("templates.portablePreviewHint"),
        ...(fork && template.actions.editor ? { edit: () => fork(ref) } : {}),
        async preview(host) {
          const value = await api.preview(query);
          const output = document.createElement("div");
          host.replaceChildren(output);
          if (value.model.kind === "site") {
            const label = document.createElement("p");
            label.textContent = t("templates.siteProfileIllustration");
            host.prepend(label);
          }
          const [runtime, images] = await Promise.all([previews(), templatePreviewImages(value.model, query)]);
          if (output.isConnected) runtime.previewPortable(output, value.model, t, images);
        },
        async export() {
          downloadTemplate(await api.export(query), `${ref.id}-${ref.version}.skill.json`);
        },
        async setEnabled(enabled) {
          await api.state(detail, enabled ? "enable" : "disable");
        },
        async activate() {
          await api.state(detail, "activate");
        },
      };
    },
  };
}
