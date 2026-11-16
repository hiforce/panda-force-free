import type { Translate } from "../../shared/i18n/messages.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import { pluginExports } from "../../shared/plugins/exports.js";
import { pluginApi } from "../plugins/api.js";
import { packageReview } from "../plugins/views.js";
import { presentationLabel } from "../presentation-labels.js";
import { skillManagerApi as skills } from "./api.js";
import { skillApproval } from "./import-views.js";
import type { TemplateImportCandidate } from "./import-ports.js";

/** Compatibility adapters keep existing package authorities and approval semantics intact. */
export async function inspectCompatibilityTemplate(
  t: Translate,
  content: string,
  name: string,
  value: unknown,
): Promise<TemplateImportCandidate> {
  if (
    value &&
    typeof value === "object" &&
    "schema" in value &&
    value.schema === 1 &&
    "manifest" in value &&
    typeof value.manifest === "string"
  ) {
    const review = await skills.review(content, name);
    return {
      choices: review.manifest.skills.map((item) => ({
        key: item.id,
        label: item.name[document.documentElement.lang] || item.name.en!,
      })),
      async review(selected) {
        const approved = await skills.review(content, name, selected);
        return {
          approval: (t) => skillApproval(t, approved),
          async install(id) {
            await skills.install(content, name, approved, id);
          },
        };
      },
    };
  }
  const pkg = value as PluginPackage,
    review = await pluginApi.review(pkg),
    exports = pluginExports(review.manifest);
  return {
    choices: exports.map((ref) => ({
      key: ref.kind + ":" + ref.id,
      label: presentationLabel(
        t,
        [...review.manifest.siteThemes, ...review.manifest.channelTemplates].find((item) => item.id === ref.id)!,
      ),
    })),
    async review(selected) {
      const approved = await pluginApi.reviewSelection(
        pkg,
        exports.filter((ref) => selected.includes(ref.kind + ":" + ref.id)),
      );
      return {
        approval: (t) => packageReview(t, approved, "managedImport", "templates.install"),
        async install() {
          await pluginApi.install(pkg, approved);
        },
      };
    },
  };
}
