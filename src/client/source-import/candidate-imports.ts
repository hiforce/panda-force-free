import type { Translate } from "../../shared/i18n/messages.js";
import type { TemplateSourceCandidate, TemplateSourceKind } from "../../shared/templates/sources/contracts.js";
import { createTemplateImportReview } from "../templates/import-review.js";
import { inspectSourceTemplates } from "../templates/source-import.js";
import { createNativeThemeImport } from "../templates/native-theme-import.js";
import { createNativeSlidesImport } from "../templates/native-slides-import.js";
import { PluginApiError } from "../plugins/api.js";
import type { NativeSlidesSelection } from "../../shared/slides/registry.js";

type Source = { id: string; sha256: string };
/** The source viewer selects explicit installed adapters; one format cannot silently fall through to another engine. */
export function createCandidateImports(t: Translate, host: HTMLElement, changed: () => void) {
  const target = host.querySelector<HTMLElement>("[data-source-template-review]")!;
  const portable = createTemplateImportReview(t, target, changed);
  const native = createNativeThemeImport(t, host.querySelector<HTMLElement>("[data-source-native-review]")!, changed);
  const office = createNativeSlidesImport(t, host.querySelector<HTMLElement>("[data-source-office-review]")!, changed);
  const handlers: Partial<
    Record<TemplateSourceKind, (source: Source, candidate: TemplateSourceCandidate) => Promise<void>>
  > = {
    "portable-library": (source, candidate) => {
      target.hidden = false;
      return portable.load(() => inspectSourceTemplates(t, { ...source, root: candidate.root }));
    },
    "hexo-theme": (source, candidate) => native.load({ ...source, root: candidate.root }, "hexo"),
    "docusaurus-theme": (source, candidate) => native.load({ ...source, root: candidate.root }, "docusaurus"),
    "powerpoint-template": loadOffice,
    "powerpoint-bundle": loadOffice,
  };
  function loadOffice(source: Source, candidate: TemplateSourceCandidate) {
    const location = candidate.location;
    if (!location || (candidate.kind === "powerpoint-bundle" && location.kind !== "directory"))
      return Promise.reject(new PluginApiError(400, { messageId: "templates.officeInvalidPackage" }));
    const selection: NativeSlidesSelection =
      location.kind === "directory" ? { kind: "bundle", root: location.path } : location;
    return office.load({ ...source, selection });
  }
  function reset() {
    portable.reset();
    native.reset();
    office.reset();
    target.hidden = true;
  }
  return {
    reset,
    choose(source: Source, candidate: TemplateSourceCandidate) {
      reset();
      return handlers[candidate.kind]?.(source, candidate);
    },
  };
}
