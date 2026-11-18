import { codexIcon } from "./codex-icons.js";
import { localizeAttribute, setMessageHtml, setOpaqueText } from "./i18n.js";
import { storage, STORAGE_KEYS } from "./storage.js";
import type { Translate } from "../shared/i18n/messages.js";
import { createComposerContexts } from "./message-composer-contexts.js";

/** Folding changes visibility only; inputs, uploads, selections and listeners keep their identity. */
export function createComposerDisclosure(
  form: HTMLFormElement,
  t: Translate,
  identity: string | undefined,
  initialScope: string,
) {
  const body = document.createElement("div"),
    button = document.createElement("button"),
    summary = document.createElement("span"),
    icon = document.createElement("span");
  body.className = "message-composer-body";
  body.id = "composer-editing-" + crypto.randomUUID();
  body.append(...form.childNodes);
  button.type = "button";
  button.className = "message-composer-disclosure";
  button.setAttribute("aria-controls", body.id);
  summary.className = "message-composer-collapsed-summary";
  button.append(summary, icon);
  form.append(button, body);
  // Autocomplete floats above the input and must escape the bounded editing area.
  const autocomplete = body.querySelector<HTMLElement>(":scope > .composer-autocomplete");
  if (autocomplete) form.append(autocomplete);
  form.classList.add("has-composer-disclosure");
  const contexts = createComposerContexts(form, body, t);
  const saved: unknown = identity ? storage.getSessionJson(STORAGE_KEYS.composerDisclosureFor(identity), {}) : {};
  const states = new Map(
    Object.entries(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {})
      .filter(([key, value]) => key.length <= 4096 && typeof value === "boolean")
      .slice(-64),
  );
  let scope = initialScope,
    collapsed = states.get(scope) === true,
    previousIcon = "";
  let first: Element | undefined;
  function mergeStoredStates() {
    if (!identity) return;
    const latest: unknown = storage.getSessionJson(STORAGE_KEYS.composerDisclosureFor(identity), null);
    if (!latest || typeof latest !== "object" || Array.isArray(latest)) return;
    for (const [key, value] of Object.entries(latest))
      if (key.length <= 4096 && typeof value === "boolean") states.set(key, value);
  }
  function refresh() {
    contexts.refresh();
    form.classList.toggle("composer-collapsed", collapsed);
    if (body.hidden !== collapsed) body.hidden = collapsed;
    if (collapsed && autocomplete) autocomplete.hidden = true;
    body.inert = collapsed;
    button.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "composer.expandInput" : "composer.collapseInput";
    localizeAttribute(button, "aria-label", label, undefined, t);
    localizeAttribute(button, "title", label, undefined, t);
    const nextIcon = collapsed ? "chevronUp" : "chevronDown";
    if (previousIcon !== nextIcon) {
      setMessageHtml(icon, codexIcon(nextIcon));
      previousIcon = nextIcon;
    }
    const input = body.querySelector("textarea"),
      text = input?.value.trim();
    const files = contexts.count("files"),
      skills = contexts.count("skills");
    const content =
      text ||
      (files || skills ? t("composer.collapsedInputContents", { files, skills }) : t("composer.collapsedInputHint"));
    if (summary.textContent !== content) setOpaqueText(summary, content);
    if (!collapsed) {
      const candidate = [...body.children].find(
        (child) =>
          child instanceof HTMLElement &&
          !child.hidden &&
          getComputedStyle(child).display !== "none" &&
          child.tagName !== "INPUT",
      );
      const next = candidate?.matches(".message-composer-contexts")
        ? candidate.querySelector(".message-composer-tray:not([hidden])") || undefined
        : candidate;
      if (next !== first) {
        first?.classList.remove("composer-disclosure-first");
        next?.classList.add("composer-disclosure-first");
        first = next;
      }
    }
  }
  const observer = new MutationObserver(refresh);
  observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  body.addEventListener("input", refresh);
  button.onclick = () => {
    collapsed = !collapsed;
    mergeStoredStates();
    states.delete(scope);
    states.set(scope, collapsed);
    while (states.size > 64) states.delete(states.keys().next().value!);
    if (identity) storage.setSessionJson(STORAGE_KEYS.composerDisclosureFor(identity), Object.fromEntries(states));
    refresh();
    form.dispatchEvent(new CustomEvent("composer:visibility-changed"));
    if (!collapsed) body.querySelector("textarea")?.focus({ preventScroll: true });
  };
  refresh();
  return {
    refresh,
    setScope(next: string) {
      if (next !== scope) {
        contexts.close();
        mergeStoredStates();
        scope = next;
        collapsed = states.get(scope) === true;
        form.dispatchEvent(new CustomEvent("composer:scope-changed"));
      }
      refresh();
    },
    dispose() {
      contexts.dispose();
      observer.disconnect();
      body.removeEventListener("input", refresh);
      button.onclick = null;
    },
  };
}
