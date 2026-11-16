import { previewSkill } from "./skill-preview.js";
import { portableTemplatePreview as previewPortable } from "./portable-preview.js";
import { loadWritingSkillAuthoring } from "./lazy-authoring.js";
import type { WritingSkillAuthoring } from "./authoring-port.js";
import { createManagedTemplateDetail } from "./detail.js";
import { templateDetailAdapters } from "./detail-adapters.js";
import { PluginApiError } from "../plugins/api.js";
import { errorText } from "../i18n.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import type { TemplateCommandCallbacks } from "./command-port.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import { createTemplateLibrary } from "../plugins/library/controller.js";
import { createNativeTemplateImport } from "./native-import.js";
import { createSourceImport } from "../source-import/controller.js";

export function createTemplateCommands(
  t: Translate,
  identity: string | undefined,
  callbacks: TemplateCommandCallbacks,
) {
  const library = createTemplateLibrary(t, callbacks.refresh, "managedPublishingDrafts");
  const sourceImporter = createSourceImport(t, callbacks.refresh);
  const importer = createNativeTemplateImport(t, callbacks.refresh, (file) => sourceImporter.open(file));
  // Keep actions understood by already-open application versions usable during a rolling release.
  let authoring: WritingSkillAuthoring | null = null,
    detail: ReturnType<typeof createManagedTemplateDetail> | null = null,
    epoch = 0;
  async function writing() {
    const generation = epoch,
      runtime = await loadWritingSkillAuthoring();
    if (generation !== epoch) return null;
    authoring ??= runtime.createTemplateAuthoring(
      t,
      identity || "local",
      callbacks.refresh,
      (error) =>
        callbacks.notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        ),
      callbacks.creationStatus,
    );
    return authoring;
  }
  const commands = {
    get creating() {
      return authoring?.creating || false;
    },
    async run(action: string, item?: ManagedTemplate) {
      if (action === "import") importer.open();
      if (action === "source-import") await sourceImporter.open();
      if (action === "drafts") library.open();
      if (action === "article") await (await writing())?.create();
      if (action === "article-drafts") (await writing())?.library();
      if (action === "detail" && item) {
        detail ??= createManagedTemplateDetail(
          t,
          async () =>
            templateDetailAdapters(
              t,
              identity,
              async () => commands,
              writing,
              async () => ({ previewSkill, previewPortable }),
            ),
          callbacks.refresh,
        );
        await detail.open(item);
      }
    },
    editPresentation: (draft: PluginPackage) => library.open(draft),
    close() {
      epoch++;
      authoring?.close();
      detail?.close();
      importer.close();
      sourceImporter.close();
      library.close(false);
    },
  };
  return commands;
}
