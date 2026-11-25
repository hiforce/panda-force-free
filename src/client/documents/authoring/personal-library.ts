import type { MessageId, Translate } from "../../../shared/i18n/messages.js";
import { creativeKindIcons, creativeKindMessages } from "../../../shared/creative/file-types.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { codexIcon } from "../../codex-icons.js";
import { readerIcon } from "../../creative/reader-toolbar.js";
import { localizeAttribute, localizeText, messageAttributes, messageHtml, setMessageHtml } from "../../i18n.js";
import { storage } from "../../storage.js";
import type { DocumentTreeIndex } from "./tree-model.js";
import { personalWorkCard } from "./personal-work-card.js";

const categories = {
  document: { text: "creative.document", icon: "file" },
  image: { text: creativeKindMessages.image, icon: creativeKindIcons.image },
  slides: { text: creativeKindMessages.slides, icon: creativeKindIcons.slides },
  video: { text: creativeKindMessages.video, icon: creativeKindIcons.video },
  web: { text: creativeKindMessages.web, icon: creativeKindIcons.web },
  file: { text: "creative.otherFiles", icon: creativeKindIcons.file },
  trash: { text: "creative.recycleBin", icon: "trash" },
} as const satisfies Record<string, { text: MessageId; icon: string }>;

export type PersonalCategory = keyof typeof categories;
export const personalCategory = (value: string | null): PersonalCategory =>
  value && Object.hasOwn(categories, value) ? (value as PersonalCategory) : "document";

export function personalCategories(t: Translate) {
  return `<nav class="personal-categories" ${messageAttributes("aria-label", "creative.libraryCategories", {}, t)}>${Object.entries(
    categories,
  )
    .map(
      ([key, value]) =>
        `<button type="button" data-personal-category="${key}" aria-pressed="false">${codexIcon(value.icon)}${messageHtml(value.text, {}, t)}</button>`,
    )
    .join("")}</nav>`;
}

export function personalLibrarySurface(t: Translate, editor: string) {
  const shortcut = (label: MessageId, icon: string, href: string) =>
    `<a class="wb-button personal-library-nav-action" href="${href}" ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("title", label, {}, t)}>${codexIcon(icon)}</a>`;
  const action = (label: MessageId, icon: string, attrs: string) =>
    `<button type="button" class="wb-button personal-library-list-action" ${attrs} ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("title", label, {}, t)}>${codexIcon(icon)}${messageHtml(label, {}, t)}</button>`;
  return `<div class="personal-library-surface"><section class="personal-library-list" data-personal-list>
    <header class="personal-library-heading">
      <div class="personal-library-navigation">
        ${shortcut("creative.backCreate", "arrowLeft", "/create")}
        <h1 data-personal-heading tabindex="-1">
          <span class="personal-library-category-name" data-personal-category-label></span>
          <button type="button" class="personal-library-category-trigger" data-authoring-action="directory" aria-controls="authoringDirectory" aria-expanded="false" aria-haspopup="dialog" ${messageAttributes("title", "creative.libraryCategories", {}, t)}><span data-personal-category-label></span>${codexIcon("chevronDown")}</button>
        </h1>
        ${shortcut("creation.activityTitle", "clock", "/create?view=activity")}
      </div>
      <div class="personal-library-controls">
        <label class="wb-form personal-library-search"><span class="wb-control-with-icon">${codexIcon("search")}<input type="search" class="wb-input" id="documentSearch" ${messageAttributes("aria-label", "creative.search", {}, t)} ${messageAttributes("placeholder", "creative.search", {}, t)} autocomplete="off"></span></label>
        <button type="button" class="wb-button personal-library-view" data-personal-toggle-view hidden></button>
        ${action("documents.newDocument", "plus", 'data-authoring-action="new" data-personal-new')}
        ${action("creative.assetImport", "fileInput", 'data-file-action="import" data-personal-import hidden')}
        <div data-personal-trash-tabs role="group" ${messageAttributes("aria-label", "creative.recycleBin", {}, t)} hidden><button type="button" class="wb-button" data-personal-trash="documents" aria-pressed="true">${messageHtml("creative.document", {}, t)}</button><button type="button" class="wb-button" data-personal-trash="files" aria-pressed="false">${messageHtml("creative.file", {}, t)}</button></div>
      </div>
    </header>
    <div data-personal-documents></div><div data-personal-files hidden></div><div data-personal-deleted-documents hidden></div>
    </section><section class="personal-library-reader" data-personal-reader hidden><header class="personal-library-reader-bar"><h1 data-personal-reader-title tabindex="-1" data-i18n-ignore></h1><div class="personal-reader-actions"><div class="personal-reader-commands document-file-commands" data-personal-doc-commands hidden></div><div class="personal-reader-commands" data-personal-asset-commands hidden></div>${readerIcon(t, "creative.closeContent", "x", 'data-authoring-action="close-content"')}</div></header>${editor}<section class="personal-library-asset" data-personal-asset hidden><div data-asset-detail></div></section></section></div>`;
}

/** The list stays mounted while reading so returning can restore its original scroll and focused row. */
export class PersonalCreationLibrary {
  category: PersonalCategory = "document";
  trashFiles = false;
  private row: { selector: string; id: string } | undefined;
  private scroll = 0;
  private readonly modeKey: string;
  private readonly modes: Partial<Record<PersonalCategory, "cards" | "list">>;
  constructor(
    private readonly root: HTMLElement,
    private readonly t: Translate,
    identity: string,
  ) {
    this.modeKey = "panda-force-personal-works-view:" + identity;
    const saved = storage.getJson(this.modeKey, {});
    this.modes = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }

  get view() {
    if (this.category === "trash") return "list";
    const saved = this.modes[this.category];
    return saved === "list" || saved === "cards"
      ? saved
      : ["document", "image", "slides", "video"].includes(this.category)
        ? "cards"
        : "list";
  }
  toggleView() {
    this.modes[this.category] = this.view === "cards" ? "list" : "cards";
    storage.setJson(this.modeKey, this.modes);
  }

  private get list() {
    return this.root.querySelector<HTMLElement>("[data-personal-list]")!;
  }
  private get scroller() {
    return matchMedia("(max-width:700px)").matches
      ? (this.root.closest<HTMLElement>(".workbench-view") ?? this.list)
      : this.list;
  }
  update() {
    const category = this.category,
      docs = category === "document",
      trash = category === "trash";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-personal-category]"))
      button.setAttribute("aria-pressed", String(button.dataset.personalCategory === category));
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-personal-trash]"))
      button.setAttribute("aria-pressed", String((button.dataset.personalTrash === "files") === this.trashFiles));
    for (const [selector, visible] of [
      ["[data-personal-new]", docs],
      ["[data-personal-toggle-view]", !trash],
      [".personal-library-search", !trash],
      ["[data-personal-documents]", docs],
      ["[data-personal-files]", !docs && (!trash || this.trashFiles)],
      ["[data-personal-trash-tabs]", trash],
      ["[data-personal-deleted-documents]", trash && !this.trashFiles],
    ] as const)
      this.root.querySelector<HTMLElement>(selector)!.hidden = !visible;
    const mode = this.root.querySelector<HTMLButtonElement>("[data-personal-toggle-view]")!;
    const view = this.view;
    if (mode.dataset.view !== view) {
      mode.dataset.view = view;
      const label = view === "cards" ? "creative.showWorksList" : "creative.showWorksCards";
      setMessageHtml(mode, codexIcon(view === "cards" ? "list" : "layout"));
      localizeAttribute(mode, "aria-label", label, {}, this.t);
      localizeAttribute(mode, "title", label, {}, this.t);
    }
    const label = categories[category].text;
    for (const element of this.root.querySelectorAll("[data-personal-category-label]"))
      localizeText(element, label, {}, this.t);
  }
  setImportAvailable(available: boolean) {
    this.list.querySelector<HTMLButtonElement>("[data-personal-import]")!.hidden = !available;
  }
  documents(index: DocumentTreeIndex, search: string, loading: boolean, disabled: boolean) {
    const host = this.root.querySelector<HTMLElement>("[data-personal-documents]")!;
    if (this.category !== "document") return;
    const needle = search.trim().toLocaleLowerCase(),
      rows = index.tree.nodes.filter((node) => index.path(node.documentId).toLocaleLowerCase().includes(needle));
    const active = document.activeElement?.getAttribute("data-personal-document");
    const asCards = this.view === "cards";
    host.classList.toggle("personal-works-grid", asCards && rows.length > 0);
    const date = new Intl.DateTimeFormat(document.documentElement.lang || "en", { dateStyle: "medium" });
    setMessageHtml(
      host,
      rows.length
        ? rows
            .sort(
              (left, right) =>
                right.document.updatedAt - left.document.updatedAt || left.documentId.localeCompare(right.documentId),
            )
            .map((node) => {
              const action = `data-personal-document="${e(node.documentId)}"`;
              const metadata =
                (node.parentId ? index.path(node.parentId) + " · " : "") + date.format(node.document.updatedAt);
              return asCards
                ? personalWorkCard(this.t, {
                    kind: "document",
                    title: node.document.title,
                    metadata,
                    icon: "file",
                    action,
                    disabled,
                  })
                : `<button type="button" class="authoring-files-item" ${action} ${disabled ? "disabled" : ""}>${codexIcon("file")}<span><strong data-i18n-ignore>${e(node.document.title)}</strong><small data-i18n-ignore>${e(metadata)}</small></span></button>`;
            })
            .join("")
        : `<p role="status">${messageHtml(loading ? "documents.loading" : needle ? "creative.assetNoMatches" : "creative.emptyCategory", {}, this.t)}</p>`,
    );
    if (active)
      host
        .querySelector<HTMLElement>(`[data-personal-document="${CSS.escape(active)}"]`)
        ?.focus({ preventScroll: true });
  }
  read(kind: "document" | "asset", id: string, title: string, fromList: boolean) {
    if (!this.list.hidden && fromList) {
      this.scroll = this.scroller.scrollTop;
      this.row = { selector: kind === "document" ? "data-personal-document" : "data-file-id", id };
    }
    this.list.hidden = true;
    this.root.classList.add("personal-content-open");
    this.root.querySelector<HTMLElement>("[data-personal-reader]")!.hidden = false;
    this.root.querySelector<HTMLElement>("[data-personal-asset]")!.hidden = kind !== "asset";
    const name = this.root.querySelector<HTMLElement>("[data-personal-reader-title]")!;
    name.textContent = title;
    name.title = title;
    this.root.querySelector<HTMLElement>("[data-personal-doc-commands]")!.hidden = kind !== "document";
    this.root.querySelector<HTMLElement>("[data-personal-asset-commands]")!.hidden = kind !== "asset";
    this.root.querySelector<HTMLElement>("#documentEditor")!.hidden = kind !== "document";
    this.scroller.scrollTop = 0;
  }
  showList(restore: boolean) {
    this.root.classList.remove("personal-content-open");
    this.root.querySelector<HTMLElement>("[data-personal-reader]")!.hidden = true;
    this.list.hidden = false;
    if (restore) {
      this.scroller.scrollTop = this.scroll;
      const row =
        this.row && this.root.querySelector<HTMLElement>(`[${this.row.selector}="${CSS.escape(this.row.id)}"]`);
      (row?.getClientRects().length ? row : this.root.querySelector<HTMLElement>("[data-personal-heading]"))?.focus({
        preventScroll: true,
      });
    }
  }
  focusList() {
    this.scroll = 0;
    this.row = undefined;
    this.showList(true);
  }
}
