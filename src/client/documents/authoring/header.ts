import type { MessageId, Translate } from "../../../shared/i18n/messages.js";
import { setMessageHtml, messageHtml } from "../../i18n.js";
import { escapeHtml } from "../../../shared/html.js";

/** Persistent navigation controls survive editor remounts and change placement without cloning IDs or focus. */
export class AuthoringHeader {
  private breadcrumb: HTMLElement | null = null;
  private refresh: HTMLElement | null = null;
  private pathKey: string | null = null;
  constructor(
    private root: HTMLElement,
    private t: Translate,
  ) {}
  mount() {
    this.pathKey = null;
    this.breadcrumb = this.root.querySelector("#authoringBreadcrumb");
    this.refresh = this.root.querySelector('[data-authoring-action="refresh-tree"]');
  }
  update(path: string[], mobile: boolean, rootLabel: MessageId = "documents.rootFolder") {
    const context = this.root.querySelector(".document-authoring-context"),
      slot = this.root.querySelector(".document-editor-breadcrumb-slot"),
      utilities = this.root.querySelector(".authoring-directory-utilities");
    if (this.breadcrumb) {
      const target = mobile || !slot ? context : slot;
      if (target && this.breadcrumb.parentElement !== target) target.append(this.breadcrumb);
      const key = JSON.stringify(path);
      if (key !== this.pathKey) {
        setMessageHtml(
          this.breadcrumb,
          messageHtml(rootLabel, undefined, this.t) + (path.length ? " / " + path.map(escapeHtml).join(" / ") : ""),
        );
        this.breadcrumb.title = path.join(" / ");
        this.pathKey = key;
      }
    }
    const target = mobile && !this.root.classList.contains("is-editing") ? context : utilities;
    if (this.refresh && target && this.refresh.parentElement !== target) target.append(this.refresh);
  }
}
