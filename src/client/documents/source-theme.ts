import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { BUILD_ENGINES } from "../../shared/builds/engines.js";
import { DEFAULT_THEME_DEPENDENCIES } from "../../shared/builds/toolchain.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";
import { pluginApi, PluginApiError } from "../plugins/api.js";
import { documentApi, DocumentApiError } from "./api.js";
import { field } from "./views.js";
import type { DocumentModal } from "./modal.js";

/** Capture from a source directory and hand off to the existing package review, never implicit approval. */
export class SourceThemeDialog {
  constructor(
    private t: Translate,
    private modal: DocumentModal,
  ) {}
  async open(space: DocumentSpace) {
    const request = this.modal.generation,
      t = this.t,
      options = await documentApi.sourceOptions(space.id);
    if (request !== this.modal.generation) return null;
    if (!options.themes.length) throw new DocumentApiError(400, { messageId: "documents.noSourceThemes" });
    return this.modal.form(
      t("documents.packageSourceTheme"),
      `<p>${m("documents.packageSourceThemeHint", undefined, t)}</p><label for="doc-sourceTheme">${m("documents.sourceThemeDirectory", undefined, t)}</label><select id="doc-sourceTheme" name="document-sourceTheme">${options.themes.map((theme) => `<option value="${e(theme)}">${e(theme)}</option>`).join("")}</select>${field(t, "plugins.packageId", "id", "example.journal", 'required maxlength="40"')}${field(t, "plugins.packageVersion", "version", "1.0.0", 'required maxlength="14"')}${field(t, "documents.spaceName", "name", space.name, 'required maxlength="120"')}<label for="doc-dependencies">${m("documents.themeDependencies", undefined, t)}</label><textarea id="doc-dependencies" name="document-dependencies" class="source-profile-json" rows="8" maxlength="8192" spellcheck="false">${e(JSON.stringify(DEFAULT_THEME_DEPENDENCIES, null, 2))}</textarea><p>${m("documents.themeDependenciesHint", undefined, t)}</p>`,
      t("documents.packageForReview"),
      async (fields) => {
        try {
          let dependencies: Record<string, string>;
          try {
            dependencies = JSON.parse(fields.dependencies!);
          } catch {
            throw new DocumentApiError(400, { messageId: "plugins.invalidPackage" });
          }
          const result = await pluginApi.fromSource(space.id, fields.sourceTheme!, {
            schema: 1,
            id: fields.id!,
            version: fields.version!,
            name: fields.name!,
            description: "",
            permissions: ["content:site-themes", "build:theme-code"],
            channelTemplates: [],
            siteThemes: [
              {
                id: "site",
                name: fields.name!,
                description: "",
                engine: "hexo",
                engineVersion: BUILD_ENGINES.hexo,
                root: "theme",
                dependencies,
              },
            ],
          });
          return result.package;
        } catch (error) {
          if (error instanceof PluginApiError) throw new DocumentApiError(error.status, error.payload);
          throw error;
        }
      },
    );
  }
}
