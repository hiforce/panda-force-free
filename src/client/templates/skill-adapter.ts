import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { PluginApiError } from "../plugins/api.js";
import { downloadTemplate, skillManagerApi as api } from "./api.js";
import type { TemplateManagerAdapter, TemplateDetailPreviewRuntime } from "./ports.js";
import { localizedText } from "../../shared/presentation/localized.js";
import { skillDisplayDefinition } from "../../shared/presentation/skill-display.js";

export function skillManagerAdapter(
  t: Translate,
  apply: ((selection: CreationSkillSelection) => Promise<void>) | undefined,
  previews: () => Promise<TemplateDetailPreviewRuntime>,
): TemplateManagerAdapter {
  return {
    registry: "skills",
    async load(template) {
      const ref = template.reference;
      if (ref.registry !== "skills") throw new PluginApiError(400, { messageId: "skills.invalidInput" });
      const detail = await api.detail(ref.packageId, ref.version);
      if (
        !detail.package ||
        detail.package.digest !== ref.digest ||
        !detail.package.manifest.skills.some((item) => item.id === ref.exportId)
      )
        throw new PluginApiError(409, { messageId: "skills.reviewChanged" });
      const definition = skillDisplayDefinition(
        detail.package,
        detail.package.manifest.skills.find((item) => item.id === ref.exportId)!,
      );
      return {
        ...(apply && definition.outputTypes.includes("document") && !definition.entitlement
          ? {
              apply: () =>
                apply({
                  packageId: ref.packageId,
                  version: ref.version,
                  digest: ref.digest,
                  id: ref.exportId,
                  parameters: {},
                }),
            }
          : {}),
        hint: t("templates.skillScopeHint"),
        async overview(target) {
          if (!definition.readme) return;
          const introduction = document.createElement("div");
          introduction.className = "template-introduction";
          introduction.textContent = localizedText(definition.readme, document.documentElement.lang);
          target.querySelector(".template-detail-cover")?.after(introduction);
        },
        async preview(host) {
          const value = await api.template(ref.packageId, ref.version, ref.exportId);
          const runtime = await previews();
          if (host.isConnected)
            runtime.previewSkill(
              host,
              value.content,
              t(value.kind === "structure" ? "templates.structurePreview" : "templates.instructionsPreview"),
            );
        },
        async export() {
          downloadTemplate(await api.export(ref.packageId, ref.version), `${ref.packageId}-${ref.version}.skill.json`);
        },
        async setEnabled(enabled) {
          await api.setExports(detail, ref.exportId, enabled);
        },
        async activate() {
          await api.activate(detail);
        },
      };
    },
  };
}
