import { directoryKey, type DirectoryEntry } from "../shared/session-discovery.js";
import type { Translate } from "../shared/i18n/messages.js";
import { codexIcon } from "./codex-icons.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "./i18n.js";

type Folder = { path: string; direct: number; total: number; children: Map<string, Folder> };

function folder(path: string): Folder {
  return { path, direct: 0, total: 0, children: new Map() };
}

export function sessionFolderTree(
  entries: readonly DirectoryEntry[],
  roots: readonly string[] | undefined,
  search = "",
) {
  const configured = roots?.map(directoryKey);
  const tree = new Map<string, Folder>();
  if (!search) for (const path of configured ?? []) tree.set(path, folder(path));
  const beneath = (path: string, root: string) => path === root || path.startsWith(root === "/" ? "/" : root + "/");
  for (const entry of entries) {
    const count = entry.unassignedCount ?? entry.count;
    const path = directoryKey(entry.path);
    if (!count || (search && !path.toLocaleLowerCase().includes(search))) continue;
    const root = configured
      ? configured.filter((candidate) => beneath(path, candidate)).sort((a, b) => b.length - a.length)[0]
      : (path.match(/^\/?[^/]+/)?.[0] ?? path);
    if (root === undefined) continue;
    let node = tree.get(root) ?? folder(root);
    tree.set(root, node);
    node.total += count;
    for (const segment of path.slice(root.length).split("/").filter(Boolean)) {
      const childPath = (node.path === "/" ? "" : node.path) + "/" + segment;
      const child = node.children.get(childPath) ?? folder(childPath);
      node.children.set(childPath, child);
      child.total += count;
      node = child;
    }
    node.direct += count;
  }
  return tree;
}

/** Subdirectories precede the conversations directly in their parent. */
export function renderSessionFolders({
  root,
  entries,
  roots,
  expanded,
  search,
  t,
  toggle,
  renderExpanded,
}: {
  root: HTMLElement;
  entries: readonly DirectoryEntry[];
  roots?: readonly string[];
  expanded: ReadonlySet<string>;
  search: string;
  t: Translate;
  toggle(path: string): void;
  renderExpanded(container: HTMLElement, path: string): void;
}) {
  const tree = sessionFolderTree(entries, roots, search);
  let index = 0;
  function render(parent: HTMLElement, item: Folder, depth: number, parentButton?: HTMLButtonElement) {
    const open = expanded.has(item.path);
    const node = document.createElement("div");
    node.className = "sidebar-folder-node";
    const button = document.createElement("button");
    button.type = "button";
    button.id = "sidebar-folder-" + index++;
    button.className = "sidebar-session-directory";
    button.style.setProperty("--sidebar-folder-indent", Math.min(depth, 5) * 8 + "px");
    button.dataset.sessionDirectory = item.path;
    button.title = item.path;
    if (!item.path) localizeAttribute(button, "title", "common.noWorkingFolder", undefined, t);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-controls", button.id + "-children");
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
    if (item.path) setOpaqueText(name, item.path.split("/").filter(Boolean).at(-1) || item.path);
    else localizeText(name, "common.noWorkingFolder", undefined, t);
    if (depth === 0) {
      setOpaqueText(path, item.path);
      label.append(name, path);
    } else {
      label.append(name);
    }
    setOpaqueText(badge, String(item.total));
    button.append(label, badge);
    button.onclick = () => toggle(item.path);
    const children = document.createElement("div");
    children.id = button.id + "-children";
    children.setAttribute("role", "group");
    children.setAttribute("aria-labelledby", button.id);
    children.hidden = !open;
    button.onkeydown = (event) => {
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowRight") {
        if (!open) toggle(item.path);
        else children.querySelector<HTMLButtonElement>("[data-session-directory]")?.focus();
        return;
      }
      if (event.key === "ArrowLeft") {
        if (open) toggle(item.path);
        else parentButton?.focus();
        return;
      }
      const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-session-directory]")];
      const at = buttons.indexOf(button);
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
      buttons[target]?.focus();
    };
    node.append(button, children);
    parent.append(node);
    if (!open) return;
    for (const child of [...item.children.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      render(children, child, depth + 1, button);
    }
    if (item.direct || !item.children.size) {
      const sessions = document.createElement("div");
      sessions.className = "sidebar-folder-sessions";
      sessions.style.setProperty("--sidebar-folder-indent", Math.min(depth, 5) * 8 + "px");
      children.append(sessions);
      if (item.direct) renderExpanded(sessions, item.path);
      else localizeText(sessions, "common.noMatchingSessions", undefined, t);
    }
  }
  for (const item of tree.values()) render(root, item, 0);
  return tree.size;
}
