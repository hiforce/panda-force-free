import { themeFields, themeOptions, describeTheme } from "./themes.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentDetail, DocumentRevision, DocumentSpace } from "../../shared/documents/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml, setMessageHtml, errorText } from "../i18n.js";

import { documentApi, DocumentApiError } from "./api.js";
import { legacyDocumentSpaces, type DocumentSpaceApi } from "./space-api.js";
import { field } from "./views.js";

import { importReport } from "./import-report.js";
import type { DocumentImportIssue } from "../../shared/documents/contracts.js";
import type { DocumentModal } from "./modal.js";
import { loadRichEditor } from "./rich-loader.js";
import type { RichEditorPort } from "./rich-port.js";
import { richLink } from "../../shared/documents/rich-body.js";

export class DocumentDialogs {
  constructor(
    private t: Translate,
    private modal: DocumentModal,
    private spaces: DocumentSpaceApi = legacyDocumentSpaces,
  ) {}
  close() {
    this.modal.close();
  }
  link(current: string) {
    return this.modal.form(
      this.t("documents.formatLink"),
      field(this.t, "documents.linkUrl", "href", current, 'maxlength="2048"'),
      this.t("documents.applyLink"),
      async (fields) => (fields.href ? richLink(fields.href) : ""),
    );
  }
  importReport(imported: number, issues: DocumentImportIssue[]) {
    return this.modal.form(
      this.t("documents.imageImportReport"),
      importReport(this.t, imported, issues),
      this.t("documents.close"),
      async () => true,
    );
  }
  async theme(space: DocumentSpace) {
    const epoch = this.modal.generation;
    const { themes } = await this.spaces.themes(space.engine);
    if (epoch !== this.modal.generation) return null;
    const pending = this.modal.form(
      this.t("documents.chooseTheme"),
      themeFields(this.t, themes, space.theme),
      this.t("documents.save"),
      async (fields) => (await this.spaces.setTheme(space.id, space.version, fields.theme!)).space,
    );
    const select = this.modal.element.querySelector<HTMLSelectElement>("#doc-theme")!;
    select.onchange = () => describeTheme(this.modal.element, this.t, themes);
    describeTheme(this.modal.element, this.t, themes);
    return pending;
  }
  async space(projectId: string, defaults: { engine?: DocumentSpace["engine"]; locale?: string } = {}) {
    const t = this.t,
      requestEpoch = this.modal.generation;
    const { themes } = await this.spaces.themes();
    if (requestEpoch !== this.modal.generation) return null;
    const pending = this.modal.form(
      t("documents.createSpace"),
      `${field(t, "documents.spaceName", "name", "", 'required maxlength="100"')}${field(t, "documents.spaceCode", "code", "", 'required minlength="2" maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]+"')}<label for="doc-sourceMode">${messageHtml("documents.sourceMode", undefined, t)}</label><select id="doc-sourceMode" name="document-sourceMode"><option value="managed">${e(t("documents.managed"))}</option><option value="external">${e(t("documents.external"))}</option></select><div id="documentExternalFields" hidden>${field(t, "documents.sourceRoot", "sourceRoot", "", 'maxlength="4096"')}<button type="button" class="wb-button" id="documentInspect">${messageHtml("documents.inspect", undefined, t)}</button><p id="documentDetected" role="status"></p><p>${messageHtml("documents.externalHint", undefined, t)}</p></div><label for="doc-engine">${messageHtml("documents.engine", undefined, t)}</label><select id="doc-engine" name="document-engine"><option value="markdown">Markdown</option><option value="hexo">Hexo</option><option value="docusaurus">Docusaurus</option></select>${themeFields(t, themes, "default")}${field(t, "documents.locale", "locale", "en", 'required maxlength="35"')}<p>${messageHtml("documents.managedHint", undefined, t)}</p>`,
      t("documents.create"),
      async (fields) => {
        const result = await this.spaces.createSpace({
          projectId,
          name: fields.name!,
          code: fields.code!,
          locale: fields.locale!,
          engine: fields.engine === "hexo" ? "hexo" : fields.engine === "docusaurus" ? "docusaurus" : "markdown",
          sourceMode: fields.sourceMode === "external" ? "external" : "managed",
          sourceRoot: fields.sourceRoot,
          theme: fields.theme!,
        });
        return result.space;
      },
    );
    const mode = this.modal.element.querySelector<HTMLSelectElement>("#doc-sourceMode")!;
    const source = this.modal.element.querySelector<HTMLInputElement>("#doc-sourceRoot")!;
    mode.onchange = () => {
      const external = mode.value === "external";
      this.modal.element.querySelector<HTMLElement>("#documentExternalFields")!.hidden = !external;
      source.required = external;
    };
    const engine = this.modal.element.querySelector<HTMLSelectElement>("#doc-engine")!,
      theme = this.modal.element.querySelector<HTMLSelectElement>("#doc-theme")!;
    engine.value = defaults.engine || "markdown";
    this.modal.element.querySelector<HTMLInputElement>("#doc-locale")!.value = defaults.locale || "en";
    const updateThemes = () => {
      const compatible = themes.filter((item) => engine.value === "markdown" || item.engine === engine.value);
      const current = compatible.some((item) => `${item.id}@${item.version}` === theme.value) ? theme.value : "default";
      setMessageHtml(theme, themeOptions(t, compatible, current));
      describeTheme(this.modal.element, t, compatible);
    };
    engine.onchange = updateThemes;
    theme.onchange = () => describeTheme(this.modal.element, t, themes);
    updateThemes();
    const inspect = this.modal.element.querySelector<HTMLButtonElement>("#documentInspect")!;
    inspect.onclick = async () => {
      const epoch = this.modal.generation,
        path = source.value;
      const status = this.modal.element.querySelector<HTMLElement>("#documentDetected")!;
      inspect.disabled = true;
      try {
        const info = await this.spaces.inspect(path);
        if (epoch !== this.modal.generation || source.value !== path) return;
        this.modal.element.querySelector<HTMLSelectElement>("#doc-engine")!.value = info.engine;
        updateThemes();
        status.textContent = t("documents.detected", { engine: info.engine });
      } catch (reason) {
        if (epoch === this.modal.generation)
          status.textContent = errorText(
            reason instanceof DocumentApiError ? reason.payload : null,
            t,
            "documents.unavailable",
          );
      } finally {
        inspect.disabled = false;
      }
    };
    return pending;
  }
  properties(locale: string) {
    return this.modal.form(
      this.t("documents.documentProperties"),
      field(
        this.t,
        "documents.locale",
        "locale",
        locale,
        'required maxlength="35" pattern="[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*"',
      ) + `<p>${messageHtml("documents.documentLanguageHint", undefined, this.t)}</p>`,
      this.t("documents.applyProperties"),
      async (fields) => {
        try {
          return { locale: new Intl.Locale(fields.locale!).toString() };
        } catch {
          throw new DocumentApiError(400, { messageId: "documents.invalidInput" });
        }
      },
    );
  }
  create(space: DocumentSpace) {
    return this.modal.form(
      this.t("documents.newDocument"),
      `${field(this.t, "documents.articleTitle", "title", "", 'required maxlength="200"')}${field(this.t, "documents.documentPath", "path", "", 'required maxlength="512"')}<p>${messageHtml("documents.pathHint", undefined, this.t)}</p>${field(this.t, "documents.locale", "locale", space.locale, 'required maxlength="35"')}`,
      this.t("documents.create"),
      (fields) =>
        documentApi.create({
          spaceId: space.id,
          path: fields.path!,
          title: fields.title!,
          locale: fields.locale!,
          content: "",
        }),
    );
  }
  async history(detail: DocumentDetail): Promise<DocumentRevision | null> {
    const requestEpoch = this.modal.generation;
    const { revisions } = await documentApi.history(detail.document.id);
    if (requestEpoch !== this.modal.generation) return null;
    const pending = this.modal.form(
      this.t("documents.history"),
      `<p>${messageHtml("documents.historyHint", undefined, this.t)}</p><select id="documentRevisionSelect" name="document-revision" aria-label="${e(this.t("documents.history"))}">${revisions.map((r) => `<option value="${e(r.id)}">${e(this.t("documents.revision", { number: r.number }))} · ${e(r.title)}</option>`).join("")}</select><textarea id="documentRevisionPreview" readonly aria-label="${e(this.t("documents.preview"))}"></textarea><div id="documentRichRevisionPreview" class="document-revision-rich" hidden></div>`,
      this.t("documents.restore"),
      async (fields) => (await documentApi.revision(detail.document.id, fields.revision!)).revision,
    );
    const select = this.modal.element.querySelector<HTMLSelectElement>("#documentRevisionSelect")!;
    const preview = this.modal.element.querySelector<HTMLTextAreaElement>("#documentRevisionPreview")!;
    const epoch = this.modal.generation;
    const richHost = this.modal.element.querySelector<HTMLElement>("#documentRichRevisionPreview")!;
    let rich: RichEditorPort | null = null;
    void pending.finally(() => {
      rich?.destroy();
      rich = null;
    });
    const update = async () => {
      const id = select.value;
      try {
        const { revision } = await documentApi.revision(detail.document.id, id);
        if (epoch !== this.modal.generation || id !== select.value) return;
        rich?.destroy();
        rich = null;
        preview.hidden = !!revision.body;
        richHost.hidden = !revision.body;
        if (!revision.body) {
          preview.value = revision.content;
          return;
        }
        const runtime = await loadRichEditor();
        if (epoch !== this.modal.generation || id !== select.value) return;
        rich = runtime.createRichDocumentEditor(richHost, {
          body: revision.body,
          editable: false,
          t: this.t,
          changed: () => {},
          error: () => {},
          upload: async () => {
            throw new Error("Revision previews are read-only");
          },
          link: async () => null,
        });
      } catch (reason) {
        if (epoch === this.modal.generation)
          preview.value = errorText(
            reason instanceof DocumentApiError ? reason.payload : null,
            this.t,
            "documents.unavailable",
          );
      }
    };
    select.onchange = () => void update();
    void update();
    return pending;
  }
  review(latest: DocumentDetail) {
    return this.modal.form(
      this.t("documents.reload"),
      `<p>${messageHtml("documents.conflict", undefined, this.t)}</p><h3 data-i18n-ignore>${e(latest.revision.title)}</h3><textarea readonly aria-label="${e(this.t("documents.preview"))}">${e(latest.revision.content)}</textarea><p>${messageHtml("documents.rebaseHint", undefined, this.t)}</p>`,
      this.t("documents.rebase"),
      async () => true,
    );
  }
}
