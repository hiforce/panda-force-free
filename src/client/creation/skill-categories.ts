import {
  assignedSkillCategories,
  configuredCategoryFilter,
  skillCategoryPredicate,
  type SkillWorkspaceSnapshot,
} from "../../shared/skill-workspace.js";
import { templateLineageKey } from "../../shared/templates/catalog.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { localizedText } from "../../shared/presentation/localized.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { setMessageHtml } from "../i18n.js";
import { SkillWorkspaceClient } from "../skill-workspace/client.js";
import { creationSkillReference, type CreationSkillEntry } from "./skill-views.js";

/** Personal assignments use the same version-independent identity as the Skills library. */
export function creationSkillInCategory(
  entry: CreationSkillEntry,
  category: string,
  workspace: SkillWorkspaceSnapshot | null,
) {
  if (category === "all") return true;
  return (
    !!workspace &&
    assignedSkillCategories(
      workspace,
      creationSkillReference(entry.reference),
      (section) => entry.definition.category === section,
    ).includes(category)
  );
}

/** Category metadata loads independently; it never blocks discovery or changes selected skills. */
export class CreationSkillCategories {
  private readonly client = new SkillWorkspaceClient(true);
  private selected = "";
  private fallback = false;
  private predicate: ReturnType<typeof skillCategoryPredicate> | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly host: HTMLElement,
    private readonly t: Translate,
    private readonly changed: (reset: boolean) => void,
    initial = "",
  ) {
    this.selected = initial;
    this.unsubscribe = this.client.subscribe(() => {
      const previous = this.selected;
      this.render();
      this.changed(previous !== this.selected);
    });
    host.onclick = (event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>(
        "[data-skill-category],[data-skill-category-retry]",
      );
      if (!target || target.disabled) return;
      if (target.hasAttribute("data-skill-category-retry")) return this.refresh();
      this.fallback = false;
      if (target.dataset.skillCategory === this.selected) return;
      this.selected = target.dataset.skillCategory!;
      this.render();
      this.changed(true);
    };
    this.render();
  }
  matches(entry: CreationSkillEntry) {
    return (
      !this.client.snapshot ||
      this.selected === "all" ||
      !!this.predicate?.(
        templateLineageKey(creationSkillReference(entry.reference)),
        (section) => entry.definition.category === section,
      )
    );
  }
  reset() {
    this.selected = "";
    this.render();
  }
  refresh() {
    void this.client.load();
  }
  private render() {
    const left = this.host.querySelector("nav")?.scrollLeft || 0;
    const focused = this.host.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)?.dataset.skillCategory
      : null;
    const categories = this.client.snapshot?.categories || [];
    if (!this.client.snapshot && this.client.error && !this.selected) {
      this.selected = "all";
      this.fallback = true;
    }
    if (this.client.snapshot && this.fallback) {
      this.selected = "";
      this.fallback = false;
    }
    if (
      this.client.snapshot &&
      this.selected !== "all" &&
      !categories.some((category) => category.id === this.selected)
    )
      this.selected = (categories.find((category) => category.section === "writing") || categories[0])?.id || "";
    const filter = this.client.snapshot && configuredCategoryFilter(this.client.snapshot, this.selected);
    this.predicate = filter ? skillCategoryPredicate(filter) : null;
    const button = (id: string, label: string, icon: string) =>
      `<button type="button" class="wb-button" data-skill-category="${e(id)}" aria-pressed="${id === this.selected}">${codexIcon(icon)}<span data-i18n-ignore>${e(label)}</span></button>`;
    setMessageHtml(
      this.host,
      `<nav class="creation-skill-categories" aria-label="${e(this.t("skillWorkspace.category"))}">${button("all", this.t("creative.all"), "layout")}${categories.map((category) => button(category.id, localizedText(category.name, document.documentElement.lang), category.icon)).join("")}</nav>${this.client.error ? `<div class="creation-skill-category-notice"><span role="status">${e(this.t("creation.categoryLoadFailed"))}</span><button type="button" class="wb-button" data-skill-category-retry ${this.client.loading ? "disabled" : ""}>${e(this.t("common.retry"))}</button></div>` : ""}`,
    );
    if (focused)
      this.host
        .querySelector<HTMLElement>(`[data-skill-category="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true });
    this.host.querySelector("nav")!.scrollLeft = left;
  }
  dispose() {
    this.unsubscribe();
    this.host.onclick = null;
  }
}
