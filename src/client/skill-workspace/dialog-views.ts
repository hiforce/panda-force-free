import type { Translate } from "../../shared/i18n/messages.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { templateInSection } from "../../shared/templates/sections.js";
import { assignedSkillCategories, skillPinId, type SkillWorkspaceSnapshot } from "../../shared/skill-workspace.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m, messageAttributes as a } from "../i18n.js";
import { codexIcon } from "../codex-icons.js";
import { presentationLabel } from "../presentation-labels.js";
import { categoryName, dialogFrame, navigation } from "./views.js";
import { SUPPORTED_LOCALES } from "../i18n.js";
import type { SkillCategoryName } from "../../shared/skill-workspace.js";
export type WorkspaceDialogMode =
  | { kind: "pins" }
  | { kind: "categories" }
  | { kind: "navigation" }
  | { kind: "edit"; id?: string; name: SkillCategoryName }
  | { kind: "delete"; id: string }
  | { kind: "assign"; item: ManagedTemplate; selected: string[] };
const button = (
  t: Translate,
  id:
    | "skillWorkspace.done"
    | "skillWorkspace.createCategory"
    | "skillWorkspace.restore"
    | "skillWorkspace.save"
    | "skillWorkspace.back",
  action: string,
  primary = false,
) =>
  `<button type="button" class="wb-button ${primary ? "primary" : ""}" data-skills-action="${action}">${m(id, undefined, t)}</button>`;
export function workspaceDialogView(
  t: Translate,
  mode: WorkspaceDialogMode,
  snapshot: SkillWorkspaceSnapshot,
  selected: string,
) {
  if (mode.kind === "navigation")
    return dialogFrame(
      t,
      t("skillWorkspace.categoriesAndPins"),
      `<nav class="skills-sheet-navigation">${navigation(t, snapshot, selected, true)}</nav>`,
    );
  if (mode.kind === "pins")
    return dialogFrame(
      t,
      t("skillWorkspace.configure"),
      `<p class="skills-dialog-intro">${m("skillWorkspace.pinHint", undefined, t)}</p><h3>${m("skillWorkspace.pinned", undefined, t)} <span class="resource-badge">${snapshot.pins.length}/24</span></h3><div class="skills-pin-list">${
        snapshot.pins
          .map((pin, index) => {
            const cat = pin.kind === "category" ? snapshot.categories.find((c) => c.id === pin.id) : null,
              name = pin.kind === "category" ? (cat ? categoryName(cat) : pin.id) : presentationLabel(t, pin.label);
            return `<article class="skills-pin-row"><span class="skills-choice-icon">${codexIcon(cat?.icon || "pin")}</span><div><strong data-i18n-ignore>${e(name)}</strong><small>${m(pin.kind === "category" ? "skillWorkspace.category" : "skillWorkspace.skill", undefined, t)}${pin.kind === "skill" ? ` · v${e(pin.version)}` : ""}</small></div><button type="button" class="icon-button" data-skills-move="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""} ${a("aria-label", "skillWorkspace.moveUp", { name }, t)}>${codexIcon("chevronUp")}</button><button type="button" class="icon-button" data-skills-move="${index}" data-direction="1" ${index === snapshot.pins.length - 1 ? "disabled" : ""} ${a("aria-label", "skillWorkspace.moveDown", { name }, t)}>${codexIcon("chevronDown")}</button><button type="button" class="icon-button" data-skills-unpin="${e(skillPinId(pin))}" ${a("aria-label", "skillWorkspace.unpinNamed", { name }, t)}>${codexIcon("x")}</button></article>`;
          })
          .join("") || `<p class="skills-empty-hint">${m("skillWorkspace.noPins", undefined, t)}</p>`
      }</div><h3 class="skills-dialog-section">${m("skillWorkspace.addCategories", undefined, t)}</h3><div class="skills-pin-categories">${snapshot.categories.map((cat) => `<label><input type="checkbox" data-skills-pin-category="${e(cat.id)}" ${snapshot.pins.some((p) => p.kind === "category" && p.id === cat.id) ? "checked" : ""}>${codexIcon(cat.icon)}<span data-i18n-ignore>${e(categoryName(cat))}</span></label>`).join("")}</div>`,
      button(t, "skillWorkspace.restore", "restore") + button(t, "skillWorkspace.done", "close", true),
    );
  if (mode.kind === "categories")
    return dialogFrame(
      t,
      t("skillWorkspace.manageCategories"),
      `<div class="skills-category-heading"><p>${m("skillWorkspace.categoryHint", undefined, t)}</p>${button(t, "skillWorkspace.createCategory", "new-category", true)}</div><div class="skills-category-list">${snapshot.categories.map((cat) => `<article><span class="skills-choice-icon">${codexIcon(cat.icon)}</span><div><strong data-i18n-ignore>${e(categoryName(cat))}</strong></div><button class="wb-button" type="button" data-skills-category="${e(cat.id)}">${m("skillWorkspace.browse", undefined, t)}</button>${`<button class="icon-button" type="button" data-skills-edit-category="${e(cat.id)}" ${a("aria-label", "skillWorkspace.rename", { name: categoryName(cat) }, t)}>${codexIcon("pencil")}</button><button class="icon-button" type="button" data-skills-delete-category="${e(cat.id)}" ${a("aria-label", "skillWorkspace.deleteNamed", { name: categoryName(cat) }, t)}>${codexIcon("trash")}</button>`}</article>`).join("")}</div>`,
      button(t, "skillWorkspace.done", "close", true),
    );
  if (mode.kind === "edit")
    return dialogFrame(
      t,
      t(mode.id ? "skillWorkspace.renameCategory" : "skillWorkspace.createCategory"),
      `<form class="wb-form" id="skillsCategoryForm"><button type="submit" hidden></button>${SUPPORTED_LOCALES.map(({ code }) => `<label class="wb-field"><span>${m(({ en: "skillWorkspace.nameEn", "zh-CN": "skillWorkspace.nameZh", "zh-HK": "skillWorkspace.nameZhHk", "zh-TW": "skillWorkspace.nameZhTw" } as const)[code as keyof SkillCategoryName], undefined, t)}</span><input name="${code === "en" ? "en" : code === "zh-CN" ? "zh" : code}" data-skill-category-locale="${code}" maxlength="64" value="${e(mode.name[code as keyof SkillCategoryName] || "")}" autocomplete="off"></label>`).join("")}<p class="skills-empty-hint">${m("skillWorkspace.nameHint", undefined, t)}</p></form>`,
      button(t, "skillWorkspace.back", "categories") +
        `<button type="button" data-skills-action="save-category" class="wb-button primary">${m("skillWorkspace.save", undefined, t)}</button>`,
    );
  if (mode.kind === "delete") {
    const category = snapshot.categories.find((c) => c.id === mode.id);
    return dialogFrame(
      t,
      t("skillWorkspace.deleteCategory"),
      `<p class="skills-dialog-intro" data-i18n-ignore>${e(category ? categoryName(category) : mode.id)}</p><p>${m("skillWorkspace.deleteHint", undefined, t)}</p>`,
      button(t, "skillWorkspace.back", "categories") +
        `<button class="wb-button danger" type="button" data-skills-action="confirm-delete">${m("skillWorkspace.deleteCategory", undefined, t)}</button>`,
    );
  }
  const personal = snapshot.categories;
  return dialogFrame(
    t,
    t("skillWorkspace.organizeSkill"),
    `<p class="skills-dialog-intro" data-i18n-ignore>${e(presentationLabel(t, mode.item.label))}</p><p class="skills-empty-hint">${m("skillWorkspace.assignmentHint", undefined, t)}</p><div class="skills-pin-categories">${personal.map((cat) => `<label><input type="checkbox" data-skills-assignment="${e(cat.id)}" ${mode.selected.includes(cat.id) ? "checked" : ""}><span data-i18n-ignore>${e(categoryName(cat))}</span></label>`).join("") || `<p class="skills-empty-hint">${m("skillWorkspace.noPersonalCategories", undefined, t)}</p>`}</div>${button(t, "skillWorkspace.createCategory", "new-category")}`,
    `<button type="button" class="wb-button primary" data-skills-action="save-assignment">${m("skillWorkspace.save", undefined, t)}</button>`,
  );
}
export function assignmentFor(snapshot: SkillWorkspaceSnapshot, item: ManagedTemplate) {
  return assignedSkillCategories(snapshot, item.reference, (section) => templateInSection(item, section));
}
