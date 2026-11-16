import type { Translate } from "../../shared/i18n/messages.js";
import { portableTemplateApproval } from "./portable-approval.js";
import { portableTemplatesApi as api } from "./portable-api.js";
import type { TemplateImportCandidate } from "./import-ports.js";
import type { PortableTemplateReview } from "../../shared/templates/portable/registry.js";

export async function inspectPortableTemplates(
  t: Translate,
  content: string,
  name: string,
): Promise<TemplateImportCandidate> {
  const initial = await api.review(content, name);
  return portableImportCandidate(t, initial, {
    review: (selected) => api.review(content, name, selected),
    install: async (review, id) => {
      await api.install(content, name, review, id);
    },
  });
}
export function portableImportCandidate(
  t: Translate,
  initial: PortableTemplateReview,
  commands: {
    review(selected: string[]): Promise<PortableTemplateReview>;
    install(review: PortableTemplateReview, operationId: string): Promise<void>;
  },
  prefix = "managedImport",
): TemplateImportCandidate {
  return {
    choices: initial.candidates.map((item) => ({
      key: item.key,
      label:
        (item.manifest.name[document.documentElement.lang] || item.manifest.name.en) +
        " · " +
        item.manifest.version +
        (item.supported ? "" : " · " + t("templates.unsupportedTemplate")),
      disabled: !item.supported,
    })),
    async review(selected) {
      const review = await commands.review(selected);
      return {
        approval: (t) => portableTemplateApproval(t, review, prefix),
        async install(operationId) {
          await commands.install(review, operationId);
        },
      };
    },
  };
}
