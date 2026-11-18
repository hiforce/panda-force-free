import type { Translate } from "../../shared/i18n/messages.js";
import { createDatabaseSettings } from "../database/settings.js";
import { createOriginalStorageSettings } from "./settings.js";
/** Database setup and recovery keep their existing view while originals own a separate configuration form. */
export function createStorageSettings(t: Translate) {
  const database = createDatabaseSettings(t),
    originals = createOriginalStorageSettings(t);
  let host: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  function hide() {
    observer?.disconnect();
    observer = null;
    originals.hide();
    database.hide();
    host = null;
  }
  function show(element: HTMLElement) {
    if (host === element) return;
    hide();
    host = element;
    const root = document.createElement("div"),
      originalSlot = document.createElement("div"),
      databaseSlot = document.createElement("div");
    root.className = "original-storage-page";
    root.append(originalSlot, databaseSlot);
    element.replaceChildren(root);
    const prioritizeRecovery = () => {
      const operation = databaseSlot.querySelector(".database-operation");
      if (!operation || operation.querySelector("[data-database-done]") || root.firstElementChild === databaseSlot)
        return;
      const active =
          document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
            ? document.activeElement
            : null,
        top = active?.getBoundingClientRect().top,
        scroll = element.closest<HTMLElement>(".settings-content");
      root.prepend(databaseSlot);
      if (active && top !== undefined) {
        active.focus({ preventScroll: true });
        if (scroll) scroll.scrollTop += active.getBoundingClientRect().top - top;
      }
    };
    observer = new MutationObserver(prioritizeRecovery);
    observer.observe(databaseSlot, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    originals.show(originalSlot);
    database.show(databaseSlot);
    prioritizeRecovery();
  }
  return { show, hide };
}
