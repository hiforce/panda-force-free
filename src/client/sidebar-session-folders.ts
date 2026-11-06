import type { DirectoryEntry } from "../shared/session-discovery.js";
import type { Translate } from "../shared/i18n/messages.js";
import { codexIcon } from "./codex-icons.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "./i18n.js";

/** Render working-folder disclosures; loading and session selection stay with their existing owners. */
export function renderSessionFolders({
  root,
  entries,
  expanded,
  search,
  t,
  toggle,
  renderExpanded,
}: {
  root: HTMLElement;
  entries: readonly DirectoryEntry[];
  expanded?: string;
  search: string;
  t: Translate;
  toggle(path: string): void;
  renderExpanded(container: HTMLElement): void;
}) {
  let count = 0;
  for (const entry of entries) {
    const total = entry.unassignedCount ?? entry.count;
    if (!total || (search && expanded !== entry.path && !entry.path.toLocaleLowerCase().includes(search))) continue;
    const open = expanded === entry.path;
    const node = document.createElement("div");
    node.className = "sidebar-folder-node";
    const button = document.createElement("button");
    button.type = "button";
    button.id = "sidebar-folder-" + count;
    button.className = "sidebar-session-directory";
    button.dataset.sessionDirectory = entry.path;
    button.title = entry.path || t("common.noWorkingFolder");
    if (!entry.path) localizeAttribute(button, "title", "common.noWorkingFolder", undefined, t);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-controls", button.id + "-sessions");
    setMessageHtml(
      button,
      codexIcon("chevronRight", "sidebar-folder-chevron") + codexIcon(open ? "folderOpen" : "folder"),
    );
    const label = document.createElement("span"),
      name = document.createElement("strong"),
      path = document.createElement("span"),
      badge = document.createElement("small");
    label.className = "sidebar-session-directory-label";
    path.className = "sidebar-session-directory-path";
    if (entry.path) setOpaqueText(name, entry.path.split("/").filter(Boolean).at(-1) || entry.path);
    else localizeText(name, "common.noWorkingFolder", undefined, t);
    setOpaqueText(path, entry.path);
    setOpaqueText(badge, String(total));
    label.append(name, path);
    button.append(label, badge);
    button.onclick = () => toggle(entry.path);
    button.onkeydown = (event) => {
      const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)) toggle(entry.path);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-session-directory]")];
        const at = buttons.indexOf(button);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
        buttons[index]?.focus();
      }
    };
    const children = document.createElement("div");
    children.id = button.id + "-sessions";
    children.className = "sidebar-folder-sessions";
    children.setAttribute("role", "group");
    children.setAttribute("aria-labelledby", button.id);
    children.hidden = !open;
    node.append(button, children);
    root.append(node);
    if (open) renderExpanded(children);
    count++;
  }
  return count;
}
