import type { Translate } from "../../shared/i18n/messages.js";
import type { PortableTemplateReview, PortableInstallResult } from "../../shared/templates/portable/registry.js";
import { templateJson } from "./api.js";
import { portableImportCandidate } from "./portable-import.js";

export interface SourceTemplateReference {
  readonly id: string;
  readonly sha256: string;
  readonly root: string;
}
export async function inspectSourceTemplates(t: Translate, source: SourceTemplateReference) {
  source = Object.freeze({ ...source });
  const review = (selected?: string[]) =>
      templateJson<PortableTemplateReview>("/api/templates/from-source/review", "POST", { ...source, selected }),
    initial = await review();
  return portableImportCandidate(
    t,
    initial,
    {
      review,
      async install(value, operationId) {
        await templateJson<PortableInstallResult>("/api/templates/from-source/install", "POST", {
          ...source,
          approval: {
            operationId,
            expectedRevision: value.revision,
            reviewHash: value.reviewHash,
            selected: value.selected,
          },
        });
      },
    },
    "sourceTemplate",
  );
}
