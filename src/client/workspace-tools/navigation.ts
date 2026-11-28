import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { requireElement } from "../dom.js";
import { localizeAttribute, localizeText, messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { STORAGE_KEYS, storage } from "../storage.js";
import { createRemoteWorkspace } from "./remote-workspace.js";
import { createStorageWorkspace } from "./storage-workspace.js";
import { createWorkspaceToolRegistry, type WorkspaceTool } from "./registry.js";

type ToolLink = { id: string; name: string; href: string };

function webAddress(value: string) {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value) || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function createWorkspaceToolNavigation(
  t: Translate,
  identity: string,
  principal: () => { restricted: boolean },
  navigate: (path: string) => void,
) {
  const registry = createWorkspaceToolRegistry([
    {
      id: "remote",
      label: "remoteTools.title",
      icon: "terminal",
      available: () => !principal().restricted,
      create: createRemoteWorkspace,
    },
    {
      id: "storage",
      label: "storageConnections.title",
      icon: "database",
      available: () => !principal().restricted,
      create: createStorageWorkspace,
    },
  ]);
  const nav = document.createElement("nav");
  nav.className = "workbench-navigation workspace-tool-navigation";
  localizeAttribute(nav, "aria-label", "remoteTools.navigation", undefined, t);
  const key = STORAGE_KEYS.workspaceToolsFor(identity);
  const instances = new Map<string, ReturnType<WorkspaceTool["create"]>>();
  let active: ReturnType<WorkspaceTool["create"]> | undefined;
  let selected = "";
  let menuSignature = "";
  const msg = (id: MessageId) => messageHtml(id, undefined, t);
  function readLinks(): ToolLink[] {
    try {
      const data = JSON.parse(storage.get(key) || "[]") as ToolLink[];
      if (!Array.isArray(data)) return [];
      return data
        .filter(
          (item) =>
            typeof item?.name === "string" &&
            typeof item.id === "string" &&
            typeof item.href === "string" &&
            webAddress(item.href),
        )
        .slice(0, 32);
    } catch {
      return [];
    }
  }
  function render(id = selected) {
    selected = id;
    const menu =
      `<a class="workspace-tool-executors" href="/settings/media-executors">${codexIcon("plug")}<span>${msg("creation.mediaSettings")}</span></a>` +
      registry
        .all()
        .map(
          (tool) =>
            `<button type="button" data-workspace-tool="${tool.id}" class="${id === tool.id ? "active" : ""}" ${id === tool.id ? 'aria-current="page"' : ""}>${codexIcon(tool.icon)}<span>${msg(tool.label)}</span></button>`,
        )
        .join("") +
      readLinks()
        .map(
          (link) =>
            `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${codexIcon("link")}<span data-i18n-ignore>${escapeHtml(link.name)}</span></a>`,
        )
        .join("") +
      `<div class="workspace-tool-actions"><button type="button" class="icon-button" data-add-tool ${messageAttributes("aria-label", "remoteTools.addTool", undefined, t)} ${messageAttributes("title", "remoteTools.addTool", undefined, t)}>${codexIcon("plus")}</button></div>`;
    if (menuSignature === menu) return;
    menuSignature = menu;
    setMessageHtml(nav, menu);
    for (const button of nav.querySelectorAll<HTMLButtonElement>("[data-workspace-tool]")) {
      button.onclick = () => navigate("/tools/" + button.dataset.workspaceTool);
    }
    (requireElement("[data-add-tool]", nav) as HTMLButtonElement).onclick = openPreferences;
  }
  function openPreferences() {
    const dialog = document.createElement("dialog");
    dialog.className = "workbench-dialog workspace-tool-dialog";
    dialog.setAttribute("aria-labelledby", "workspace-tool-editor-title");
    setMessageHtml(
      dialog,
      `<header><h2 id="workspace-tool-editor-title">${msg("remoteTools.addTool")}</h2></header>
      <form class="wb-form">
        <label class="wb-field" for="workspace-tool-name"><span>${msg("remoteTools.toolName")}</span><input id="workspace-tool-name" name="workspaceToolName" maxlength="80" required autofocus></label>
        <label class="wb-field" for="workspace-tool-url"><span>${msg("remoteTools.toolUrl")}</span><input id="workspace-tool-url" name="workspaceToolUrl" type="url" maxlength="2048" placeholder="https://" autocapitalize="none" required></label>
        <ul data-workspace-tool-links></ul>
        <p role="alert" data-workspace-tool-error hidden></p>
        <footer><button type="button" class="wb-button" data-tool-close>${msg("common.close")}</button><button type="submit" class="wb-button primary">${msg("remoteTools.addLink")}</button></footer>
      </form>`,
    );
    const list = requireElement("[data-workspace-tool-links]", dialog);
    const error = requireElement("[data-workspace-tool-error]", dialog) as HTMLElement;
    const form = requireElement("form", dialog) as HTMLFormElement;
    function persist(links: ToolLink[]) {
      storage.set(key, JSON.stringify(links));
      render();
    }
    function update() {
      const links = readLinks();
      setMessageHtml(
        list,
        links
          .map(
            (link) =>
              `<li><span data-i18n-ignore>${escapeHtml(link.name)}</span><button type="button" class="icon-button" data-link-id="${escapeHtml(link.id)}" ${messageAttributes("aria-label", "remoteTools.removeTool", { name: link.name }, t)}>${codexIcon("trash")}</button></li>`,
          )
          .join(""),
      );
      for (const button of list.querySelectorAll<HTMLButtonElement>("[data-link-id]"))
        button.onclick = () => {
          persist(readLinks().filter((link) => link.id !== button.dataset.linkId));
          update();
          (requireElement("#workspace-tool-name", dialog) as HTMLInputElement).focus();
        };
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const name = String(values.get("workspaceToolName") ?? "").trim();
      const href = webAddress(String(values.get("workspaceToolUrl") ?? "").trim());
      const links = readLinks();
      if (!name || !href || links.length >= 32) {
        error.hidden = false;
        localizeText(error, links.length >= 32 ? "remoteTools.toolLimit" : "remoteTools.invalidToolUrl", undefined, t);
        return;
      }
      persist([...links, { id: crypto.randomUUID(), name, href }]);
      dialog.close();
    };
    (requireElement("[data-tool-close]", dialog) as HTMLButtonElement).onclick = () => dialog.close();
    dialog.addEventListener(
      "close",
      () => {
        dialog.remove();
        (requireElement("[data-add-tool]", nav) as HTMLButtonElement).focus({ preventScroll: true });
      },
      { once: true },
    );
    update();
    document.body.append(dialog);
    dialog.showModal();
  }
  function hide() {
    active?.hide();
    active = undefined;
  }
  function show(root: HTMLElement, id: string, url: URL) {
    const tool = registry.get(id);
    if (!tool?.available()) {
      hide();
      setMessageHtml(
        root,
        `<h1>${msg(tool?.label ?? "remoteTools.unavailableTitle")}</h1><p role="status">${msg(tool ? "remoteTools.denied" : "remoteTools.unavailableTitle")}</p>`,
      );
      return;
    }
    let instance = instances.get(id);
    if (!instance) {
      instance = tool.create(t);
      instances.set(id, instance);
    }
    if (active !== instance) hide();
    active = instance;
    instance.show(root, url);
  }
  window.addEventListener("storage", (event) => {
    if (event.key === key && nav.isConnected) render();
  });
  return { nav, render, show, hide, label: (id: string) => registry.get(id)?.label };
}
