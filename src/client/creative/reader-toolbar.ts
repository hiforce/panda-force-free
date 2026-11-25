import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { messageAttributes } from "../i18n.js";

export function readerIcon(
  t: Translate,
  label: MessageId,
  icon: string,
  attributes = "",
  tag: "button" | "a" | "summary" = "button",
) {
  return `<${tag} ${tag === "button" ? 'type="button"' : ""} class="icon-button creative-reader-action" ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("data-tooltip", label, {}, t)} ${attributes}>${codexIcon(icon)}</${tag}>`;
}

export function readerMore(t: Translate, content: string, surface: string) {
  return `<details class="creative-reader-more ${surface}">${readerIcon(t, "documents.moreActions", "ellipsis", "", "summary")}<div class="creative-reader-menu">${content}</div></details>`;
}

export function bindReaderMore(toolbar: HTMLElement, signal: AbortSignal) {
  document.addEventListener(
    "pointerdown",
    (event) => {
      const menu = toolbar.querySelector<HTMLDetailsElement>(".creative-reader-more[open]");
      if (menu && !menu.contains(event.target as Node)) menu.open = false;
    },
    { signal },
  );
  toolbar.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      const menu = toolbar.querySelector<HTMLDetailsElement>(".creative-reader-more[open]");
      if (!menu?.contains(event.target as Node)) return;
      event.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    },
    { signal },
  );
}
