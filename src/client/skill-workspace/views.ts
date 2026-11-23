import {
  builtinSkillCategories,
  defaultSkillWorkspace,
  skillPinId,
  type SkillCategory,
  type SkillWorkspaceSnapshot,
} from "../../shared/skill-workspace.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { messageHtml as m, messageAttributes as a } from "../i18n.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { presentationLabel } from "../presentation-labels.js";
import { localizedText } from "../../shared/presentation/localized.js";
export const categoryName = (category: SkillCategory) => localizedText(category.name, document.documentElement.lang);
export function navigation(t: Translate, snapshot: SkillWorkspaceSnapshot | null, selected: string, sheet = false) {
  const value = snapshot || defaultSkillWorkspace();
  return `<header class="skills-nav-heading"><span>${m("skillWorkspace.navigation", undefined, t)}</span><button class="icon-button" type="button" data-skills-action="pins" ${a("aria-label", "skillWorkspace.configure", undefined, t)}>${codexIcon("slidersHorizontal")}</button></header>
    <button type="button" class="skills-nav-link ${selected === "all" ? "active" : ""}" data-skills-category="all" ${selected === "all" ? 'aria-current="page"' : ""}>${codexIcon("layout")}${m("skillWorkspace.all", undefined, t)}</button>
    <h2>${m("skillWorkspace.pinned", undefined, t)}</h2><div class="skills-nav-pins">${
      value.pins
        .map((pin) => {
          const category = pin.kind === "category" ? value.categories.find((c) => c.id === pin.id) : null;
          const name =
            pin.kind === "category" ? (category ? categoryName(category) : pin.id) : presentationLabel(t, pin.label);
          const extra =
            pin.kind === "skill" ? `data-skills-key="${e(pin.key)}"` : `data-skills-category="${e(pin.id)}"`;
          return `<button type="button" class="skills-nav-link ${pin.kind === "category" && selected === pin.id ? "active" : ""}" ${extra} title="${e(pin.kind === "skill" ? name + " · v" + pin.version : name)}">${codexIcon(category?.icon || "pin")}<span data-i18n-ignore>${e(name)}</span>${pin.kind === "skill" ? `<span class="skills-nav-type">${m("skillWorkspace.skill", undefined, t)}</span>` : ""}</button>`;
        })
        .join("") || `<p class="skills-nav-hint">${m("skillWorkspace.noPins", undefined, t)}</p>`
    }</div>
    <button class="skills-nav-config" type="button" data-skills-action="pins">${codexIcon("slidersHorizontal")}${m("skillWorkspace.configure", undefined, t)}</button>
    ${sheet ? `<button class="skills-nav-config" type="button" data-skills-action="categories">${codexIcon("folder")}${m("skillWorkspace.manageCategories", undefined, t)}</button>` : ""}`;
}
export function workspaceFrame(t: Translate, selected: string, snapshot: SkillWorkspaceSnapshot | null) {
  return `<section class="skills-workspace"><aside class="skills-navigation" data-skills-navigation ${a("aria-label", "skillWorkspace.navigation", undefined, t)}>${navigation(t, snapshot, selected)}</aside><div class="skills-main"><div class="skills-notice" data-skills-notice hidden><p role="status" data-skills-notice-text></p><button class="wb-button" type="button" data-skills-action="retry">${m("common.retry", undefined, t)}</button></div><div data-skills-gallery></div></div></section>`;
}
export function filters(t: Translate, snapshot: SkillWorkspaceSnapshot | null, selected: string) {
  const categories = snapshot?.categories || builtinSkillCategories;
  return `<label class="skills-category-filter"><span class="sr-only">${m("skillWorkspace.category", undefined, t)}</span><select class="wb-select" data-skills-select><option value="all">${m("skillWorkspace.allCategories", undefined, t)}</option>${categories.map((c) => `<option value="${e(c.id)}" ${selected === c.id ? "selected" : ""} data-i18n-ignore>${e(categoryName(c))}</option>`).join("")}</select></label>`;
}
export function dialogFrame(t: Translate, title: string, body: string, footer = "") {
  return `<header><div><h2 id="skillWorkspaceDialogTitle">${e(title)}</h2><p>${m("skillWorkspace.personalHint", undefined, t)}</p></div><button type="button" class="icon-button" data-skills-action="close" ${a("aria-label", "common.close", undefined, t)}>${codexIcon("x")}</button></header><div class="skills-dialog-body"><div class="skills-dialog-notice" data-skills-dialog-notice hidden><p role="status"></p><button type="button" class="wb-button" data-skills-action="retry">${m("common.retry", undefined, t)}</button></div>${body}</div>${footer ? `<footer>${footer}</footer>` : ""}`;
}
export { skillPinId };
