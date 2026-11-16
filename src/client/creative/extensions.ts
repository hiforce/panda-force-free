import type { Translate } from "../../shared/i18n/messages.js";
import type { PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import { getBrowserI18n, messageHtml, setMessageHtml, setOpaqueText, errorText } from "../i18n.js";
import { presentationLabel } from "../presentation-labels.js";

import { pluginApi, PluginApiError } from "../plugins/api.js";
import { createPackageManager } from "../plugins/controller.js";
import { extensionFrame, extensionList } from "./extension-view.js";

/** Settings own discovery; the package manager retains version and permission authority. */
export function createExtensionSettings(t: Translate) {
  let host: HTMLElement | null = null,
    snapshot: PluginRegistrySnapshot | null = null,
    pending: AbortController | null = null,
    manager: ReturnType<typeof createPackageManager> | undefined,
    unsubscribe: (() => void) | undefined;
  function localizeLabels() {
    if (!host || !snapshot) return;
    for (const card of host.querySelectorAll<HTMLElement>("[data-extension-package]")) {
      const item = snapshot.packages.find(
        (p) => p.id === card.dataset.extensionPackage && p.version === card.dataset.extensionVersion,
      );
      if (!item) continue;
      for (const field of ["name", "description"] as const) {
        setOpaqueText(
          card.querySelector<HTMLElement>(`[data-extension-label="${field}"]`)!,
          presentationLabel(t, item.manifest, field),
        );
      }
    }
  }
  function renderList() {
    if (!host) return;
    setMessageHtml(host.querySelector<HTMLElement>("[data-extension-list]")!, extensionList(t, snapshot));
    setMessageHtml(
      host.querySelector<HTMLElement>("[data-extension-count]")!,
      snapshot
        ? messageHtml("plugins.settingsCount", { count: new Set(snapshot.packages.map((p) => p.id)).size }, t)
        : "",
    );
  }
  async function refresh() {
    if (!host || pending) return;
    const target = host,
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 12000),
      notice = target.querySelector<HTMLElement>("[data-extension-notice]")!,
      button = target.querySelector<HTMLButtonElement>("[data-extension-refresh]")!;
    pending = controller;
    notice.hidden = true;
    button.disabled = true;
    target.querySelector("[data-extension-list]")!.setAttribute("aria-busy", "true");
    try {
      const value = await pluginApi.list(controller.signal);
      if (pending !== controller || host !== target) return;
      snapshot = value;
      renderList();
    } catch (error) {
      if (pending !== controller || host !== target) return;
      notice.textContent = errorText(
        error instanceof PluginApiError ? error.payload : null,
        t,
        "plugins.settingsLoadFailed",
      );
      notice.hidden = false;
      if (!snapshot) target.querySelector("[data-extension-list]")!.replaceChildren();
    } finally {
      clearTimeout(timer);
      if (pending === controller) {
        pending = null;
        button.disabled = false;
        target.querySelector("[data-extension-list]")!.setAttribute("aria-busy", "false");
      }
    }
  }
  function hide() {
    if (host) host.onclick = null;
    host = null;
    unsubscribe?.();
    unsubscribe = undefined;
    const controller = pending;
    pending = null;
    controller?.abort();
    manager?.close();
  }
  return {
    show(target: HTMLElement) {
      if (host === target) return;
      hide();
      host = target;
      setMessageHtml(target, extensionFrame(t));
      renderList();
      unsubscribe = getBrowserI18n().subscribe(localizeLabels);
      target.onclick = (event) => {
        const button = (event.target as Element).closest<HTMLElement>(
          "[data-extension-manage],[data-extension-refresh]",
        );
        if (button?.hasAttribute("data-extension-refresh")) void refresh();
        else if (button?.hasAttribute("data-extension-manage")) {
          manager ??= createPackageManager(t, { id: "settingsExtensionManager", onClose: () => void refresh() });
          manager.open(undefined, button.dataset.extensionManage || undefined);
        }
      };
      void refresh();
    },
    hide,
  };
}
