import { localizedText } from "../shared/presentation/localized.js";
import { setOpaqueText } from "./i18n.js";

const names = new WeakMap<HTMLElement, Readonly<Record<string, string>>>();
/** Regional skill labels can change without rerendering or translating the user's message. */
export function bindSessionSkillLabel(element: HTMLElement, value: Readonly<Record<string, string>>, locale: string) {
  element.classList.add("session-skill-label");
  names.set(element, value);
  const text = localizedText(value, locale);
  if (text) setOpaqueText(element, text);
}
export function refreshSessionSkillLabels(root: ParentNode, locale: string) {
  for (const element of root.querySelectorAll<HTMLElement>(".session-skill-label")) {
    const value = names.get(element);
    if (value) bindSessionSkillLabel(element, value, locale);
  }
}
