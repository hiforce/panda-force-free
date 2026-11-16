import type { TemplateDefinition, TemplateFixture } from "../../../shared/plugins/library.js";
import { PACKAGE_LIMITS } from "../../../shared/plugins/contracts.js";
import { packageSha256 } from "../../../shared/plugins/validation.js";
import type { Translate, MessageId } from "../../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { setMessageHtml, messageHtml as m } from "../../i18n.js";
import { PluginApiError } from "../api.js";
import { bindChannelStyleFields } from "./style-fields.js";

const archiveFields: Record<keyof TemplateDefinition["archive"], MessageId> = {
  author: "plugins.libraryAuthor",
  license: "plugins.libraryLicense",
  licenseText: "plugins.libraryLicenseText",
  sourceUrl: "plugins.librarySource",
  sourceRevision: "plugins.librarySourceRevision",
  changelog: "plugins.libraryChangelog",
  compatibility: "plugins.libraryCompatibility",
};
const textField = (t: Translate, key: string, label: MessageId, value: string, area = false) =>
  `<label for="library-${key}">${m(label, undefined, t)}</label>${area ? `<textarea id="library-${key}" rows="3" maxlength="64000">${e(value)}</textarea>` : `<input id="library-${key}" value="${e(value)}" maxlength="1000">`}`;
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

/** Owns one in-memory working definition; server revisions and publication status stay in the controller. */
export class TemplateLibraryEditor {
  private definition: TemplateDefinition | null = null;
  private file = "";
  private modified = new Map<string, string>();
  private fixture = "";
  private matrixChanged = false;
  private matrixSeed = "";
  constructor(
    private root: HTMLElement,
    private t: Translate,
    private changed: () => void,
    private selectionChanged: () => void = () => {},
  ) {}
  private get<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id: string) {
    return this.root.querySelector<T>("#library-" + id)!;
  }
  mount(definition: TemplateDefinition, selectedFixture?: string) {
    this.definition = structuredClone(definition);
    this.modified.clear();
    this.file = "";
    this.fixture = "";
    this.matrixChanged = false;
    const t = this.t,
      { id, version, name, schema: _schema, ...exports } = definition.package.manifest;
    setMessageHtml(
      this.root,
      `<section class="library-fields">${textField(t, "id", "plugins.packageId", id)}${textField(t, "version", "plugins.packageVersion", version)}${textField(t, "name", "plugins.libraryName", name)}<details data-library-archive><summary>${m("plugins.libraryArchive", undefined, t)}</summary><div class="library-field-grid">${Object.entries(
        archiveFields,
      )
        .map(([key, label]) =>
          textField(
            t,
            "archive-" + key,
            label,
            definition.archive[key as keyof typeof archiveFields],
            ["licenseText", "changelog", "compatibility"].includes(key),
          ),
        )
        .join(
          "",
        )}</div></details><details><summary>${m("plugins.libraryExports", undefined, t)}</summary><p>${m("plugins.libraryExportsHint", undefined, t)}</p><textarea id="library-exports" class="library-code" rows="16" maxlength="131072" spellcheck="false">${e(JSON.stringify(exports, null, 2))}</textarea></details>${definition.package.files.length ? `<details><summary>${m("plugins.libraryFiles", undefined, t)}</summary><label for="library-file">${m("plugins.libraryFile", undefined, t)}</label><select id="library-file">${definition.package.files.map((file) => `<option value="${e(file.path)}">${e(file.path)}</option>`).join("")}</select><p id="library-binary" hidden>${m("plugins.libraryBinary", undefined, t)}</p><textarea id="library-fileText" class="library-code" rows="18" maxlength="1048576" spellcheck="false"></textarea></details>` : ""}<details open><summary>${m("plugins.librarySamples", undefined, t)}</summary><label for="library-fixture">${m("plugins.librarySample", undefined, t)}</label><select id="library-fixture">${definition.fixtures.map((f) => `<option value="${e(f.id)}">${e(f.name)}</option>`).join("")}</select><div class="library-field-grid">${textField(t, "fixture-title", "plugins.librarySampleTitle", "")}${textField(t, "fixture-locale", "documents.locale", "")}</div><label for="library-fixture-content">${m("plugins.librarySampleSource", undefined, t)}</label><textarea id="library-fixture-content" class="library-code" rows="12" maxlength="65536" spellcheck="false"></textarea><details><summary>${m("plugins.librarySampleMatrix", undefined, t)}</summary><p>${m("plugins.libraryMatrixHint", undefined, t)}</p><textarea id="library-fixtures" class="library-code" rows="12" maxlength="1200000" spellcheck="false">${e(JSON.stringify(definition.fixtures, null, 2))}</textarea></details></details></section>`,
    );
    const styleFields = document.createElement("div");
    styleFields.className = "library-style-fields";
    this.root.querySelector("[data-library-archive]")!.before(styleFields);
    bindChannelStyleFields(styleFields, this.get<HTMLTextAreaElement>("exports"), t);
    if (definition.package.files.length) {
      this.get("file").onchange = () => {
        this.flushFile();
        this.loadFile();
      };
      this.loadFile();
    }
    this.get("fixture").onchange = () => {
      this.flushFixture();
      this.loadFixture();
      this.selectionChanged();
    };
    if (selectedFixture && definition.fixtures.some((item) => item.id === selectedFixture))
      this.get("fixture").value = selectedFixture;
    this.loadFixture();
    this.matrixSeed = this.get("fixtures").value;
    const matrix = this.get("fixtures").closest("details")!;
    matrix.querySelector("summary")!.onclick = () => {
      if (!this.matrixChanged) this.flushFixture();
    };
    matrix.ontoggle = () => {
      if (matrix.isConnected && matrix.open && !this.matrixChanged) this.flushFixture();
    };
    this.root.oninput = (event) => {
      if (["library-fixture", "library-file"].includes((event.target as Element)?.id)) return;
      if ((event.target as Element)?.id === "library-fixtures") {
        this.matrixChanged = this.get("fixtures").value !== this.matrixSeed;
        this.controls(false, false);
      }
      this.changed();
    };
  }
  get selectedFixture() {
    return this.get("fixture")?.value || "";
  }
  private flushFile() {
    if (this.file && !this.get<HTMLTextAreaElement>("fileText").hidden)
      this.modified.set(this.file, this.get("fileText").value);
  }
  private loadFile() {
    const value = this.definition!.package.files.find((file) => file.path === this.get("file").value)!;
    this.file = value.path;
    const field = this.get<HTMLTextAreaElement>("fileText");
    try {
      field.value =
        this.modified.get(value.path) ??
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0)),
        );
      field.hidden = field.value.includes("\0");
    } catch {
      field.hidden = true;
    }
    this.root.querySelector<HTMLElement>("#library-binary")!.hidden = !field.hidden;
  }
  private flushFixture() {
    if (!this.fixture || this.matrixChanged) return;
    const fixtures = JSON.parse(this.get("fixtures").value) as TemplateFixture[],
      entry = fixtures.find((item) => item.id === this.fixture);
    if (entry) {
      entry.title = this.get("fixture-title").value;
      entry.locale = this.get("fixture-locale").value;
      entry.content = this.get("fixture-content").value;
    }
    this.get("fixtures").value = JSON.stringify(fixtures, null, 2);
    this.matrixSeed = this.get("fixtures").value;
  }
  private loadFixture() {
    this.fixture = this.get("fixture").value;
    const entry = (JSON.parse(this.get("fixtures").value) as TemplateFixture[]).find(
      (item) => item.id === this.fixture,
    );
    this.get("fixture-title").value = entry?.title || "";
    this.get("fixture-locale").value = entry?.locale || "en";
    this.get("fixture-content").value = entry?.content || "";
  }
  controls(busy: boolean, readonly: boolean) {
    for (const field of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input,select,textarea",
    ))
      field.disabled =
        busy ||
        readonly ||
        (this.matrixChanged &&
          ["library-fixture", "library-fixture-title", "library-fixture-locale", "library-fixture-content"].includes(
            field.id,
          ));
  }
  async value() {
    try {
      if (
        Array.from(
          this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input,select,textarea",
          ),
        ).some((field) => !field.checkValidity())
      )
        throw new PluginApiError(400, { messageId: "plugins.invalidLibraryDraft" });
      this.flushFile();
      this.flushFixture();
      const definition = structuredClone(this.definition!),
        exports = JSON.parse(this.get("exports").value) as Record<string, unknown>;
      if (
        Object.keys(exports).some(
          (key) => !["description", "labels", "permissions", "siteThemes", "channelTemplates"].includes(key),
        )
      )
        throw Error("Invalid exports");
      definition.package.manifest = {
        ...exports,
        schema: 1,
        id: this.get("id").value,
        version: this.get("version").value,
        name: this.get("name").value,
      } as TemplateDefinition["package"]["manifest"];
      for (const key of Object.keys(archiveFields) as (keyof typeof archiveFields)[])
        definition.archive[key] = this.get("archive-" + key).value;
      definition.fixtures = JSON.parse(this.get("fixtures").value);
      for (const file of definition.package.files)
        if (this.modified.has(file.path)) {
          const bytes = new TextEncoder().encode(this.modified.get(file.path)!);
          if (bytes.length > PACKAGE_LIMITS.fileBytes)
            throw new PluginApiError(413, { messageId: "plugins.packageTooLarge" });
          file.data = base64(bytes);
          file.sha256 = await packageSha256(bytes);
        }
      return definition;
    } catch (error) {
      if (error instanceof PluginApiError) throw error;
      throw new PluginApiError(400, { messageId: "plugins.invalidLibraryDraft" });
    }
  }
}
