import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import type { InstalledSkillPack } from "../../shared/skills/registry.js";
import type { SkillDefinition } from "../../shared/skills/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { localizedText } from "../../shared/presentation/localized.js";
import { managedCover } from "../templates/covers.js";
import { managedTemplateKey } from "../../shared/templates/catalog.js";
import { skillPresentationType } from "../../shared/skills/presentation.js";
import { creationSkillDelivery, creationSkillDeliveryNotice } from "./skill-delivery.js";
export interface CreationSkillEntry {
  reference: CreationSkillSelection;
  definition: SkillDefinition;
  name: InstalledSkillPack["manifest"]["name"];
  origin: InstalledSkillPack["origin"];
  publisher: string;
  license: string;
  enabled: boolean;
  visible: boolean;
}
export const creationSkillKey = (value: CreationSkillSelection) =>
  JSON.stringify([value.packageId, value.version, value.digest, value.id]);
export const skillText = (text: Readonly<Record<string, string>>) => localizedText(text, document.documentElement.lang);
export function creationSkillReference(ref: CreationSkillSelection) {
  return {
    registry: "skills" as const,
    kind: "skill" as const,
    packageId: ref.packageId,
    exportId: ref.id,
    version: ref.version,
    digest: ref.digest,
  };
}
/** Creation uses the same authored motifs, private image URLs and failure fallback as the library. */
export function creationSkillCover(entry: CreationSkillEntry) {
  const { reference: ref, definition: skill } = entry;
  const reference = creationSkillReference(ref);
  return managedCover({
    key: managedTemplateKey(reference),
    reference,
    templateType: skillPresentationType(skill),
    categories: [skill.category],
    compatibility: { outputs: skill.outputTypes },
    ...(skill.cover || skill.previews?.length ? { artwork: { alt: skill.cover?.alt || skill.name } } : {}),
  });
}
const detailsButton = (t: Translate, entry: CreationSkillEntry | undefined, key: string) =>
  `<button type="button" class="wb-button creation-skill-details-button" data-skill-action="details" data-skill-key="${e(key)}" aria-label="${e(t("creation.skillDetails") + (entry ? ": " + skillText(entry.definition.name) : ""))}" ${entry ? "" : "disabled"}>${e(t("creation.details"))}</button>`;
/** Composer attachments share library artwork and immutable versions without opening the creation form. */
export function composerCreationSkill(
  t: Translate,
  selection: CreationSkillSelection,
  index: number,
  entry: CreationSkillEntry | undefined,
  loading = false,
) {
  const name = entry
    ? skillText(entry.definition.name)
    : t(loading ? "creation.loadingSkill" : "creation.skillUnavailable");
  return `<article class="creative-skill-chip" data-selected-skill="${e(selection.id)}"><button type="button" class="creative-skill-preview" data-skill-action="details" data-skill-key="${e(creationSkillKey(selection))}" aria-label="${e(t("creation.skillDetails") + ": " + name)}" ${entry ? "" : "disabled"}><span class="creative-skill-art" aria-hidden="true">${entry ? creationSkillCover(entry) : codexIcon("file")}</span><span class="creative-skill-label"><strong title="${e(name)}">${e(name)}</strong><small>v${e(selection.version)}</small>${entry && creationSkillDelivery(t, entry.definition) ? `<small>${e(t("creation.skillGuidance"))}</small>` : ""}</span></button><button type="button" class="creative-skill-remove" data-skill-action="remove" data-index="${index}" data-creative-remove-skill="${index}" aria-label="${e(t("creation.removeSkill") + ": " + name)}">${codexIcon("x")}</button></article>`;
}
export function selectedCreationSkill(
  t: Translate,
  selection: CreationSkillSelection,
  index: number,
  count: number,
  entry: CreationSkillEntry | undefined,
  parameters: string,
  loading: boolean,
) {
  const action = (name: "up" | "down" | "remove", label: string, disabled = false) =>
    `<button type="button" class="wb-button icon-button" data-skill-action="${name}" data-index="${index}" aria-label="${e(label)}" ${disabled ? "disabled" : ""}>${codexIcon(name === "remove" ? "x" : "chevronDown")}</button>`;
  return `<article class="creation-skill" data-selected-skill="${e(selection.id)}"><div class="creation-skill-header"><span class="creation-skill-thumbnail" aria-hidden="true">${entry ? creationSkillCover(entry) : codexIcon("file")}</span><div class="creation-skill-copy"><strong>${e(entry ? skillText(entry.definition.name) : selection.id)}</strong><small>v${e(selection.version)}</small>${entry ? creationSkillDeliveryNotice(t, entry.definition) : ""}${!entry || !entry.enabled ? `<span class="creation-skill-availability">${e(t(loading && !entry ? "creation.loadingSkill" : "creation.skillUnavailable"))}</span>` : ""}</div>${detailsButton(t, entry, creationSkillKey(selection))}</div>${parameters ? `<details data-skill-key="${e(creationSkillKey(selection))}"><summary>${e(t("creation.parameters"))}${codexIcon("chevronDown")}</summary><div class="wb-form creation-skill-parameters">${parameters}</div></details>` : ""}<div class="creation-skill-actions">${action("up", t("creation.moveEarlier"), index === 0)}${action("down", t("creation.moveLater"), index === count - 1)}${action("remove", t("creation.removeSkill"))}</div></article>`;
}
export function creationSkillOptions(
  t: Translate,
  entries: readonly CreationSkillEntry[],
  selected: readonly CreationSkillSelection[],
  query: string,
  loading: boolean,
  accept?: (entry: CreationSkillEntry) => boolean,
) {
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.visible &&
        entry.enabled &&
        (!accept || accept(entry)) &&
        (!query ||
          [
            ...Object.values(entry.definition.name),
            ...Object.values(entry.definition.description),
            ...Object.values(entry.name),
            entry.definition.id,
            entry.reference.packageId,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())),
    );
  const chosenKeys = new Set(selected.map(creationSkillKey));
  const row = ({ entry, index }: (typeof matches)[number]) => {
    const chosen = chosenKeys.has(creationSkillKey(entry.reference)),
      name = skillText(entry.definition.name),
      description = creationSkillDelivery(t, entry.definition) || skillText(entry.definition.description);
    return `<article class="creation-skill-option" data-selected="${chosen}"><button type="button" class="creation-skill-choose" data-skill-action="add" data-skill-key="${e(creationSkillKey(entry.reference))}" data-skill-package="${e(entry.reference.packageId)}" data-skill-id="${e(entry.reference.id)}" data-index="${index}" aria-pressed="${chosen}" aria-label="${e(t(chosen ? "creation.removeSkill" : "creation.selectSkill") + ": " + name)}"><span class="creation-skill-option-art" aria-hidden="true">${creationSkillCover(entry)}</span><span class="creation-skill-option-copy"><strong class="creation-skill-option-title" title="${e(name)}">${e(name)}</strong><small title="${e(description)}">${e(description)}</small></span><span class="creation-skill-check" aria-hidden="true">${chosen ? codexIcon("check") : ""}</span></button><footer><small>v${e(entry.reference.version)}</small><button type="button" class="wb-button creation-skill-details-button" data-skill-action="details" data-skill-key="${e(creationSkillKey(entry.reference))}" aria-label="${e(t("creation.skillDetails") + ": " + name)}">${codexIcon("info")}</button></footer></article>`;
  };
  const chosen = matches.filter(({ entry }) => chosenKeys.has(creationSkillKey(entry.reference))),
    available = matches.filter(({ entry }) => !chosenKeys.has(creationSkillKey(entry.reference)));
  const group = (rows: typeof matches, label: "composer.selectedSkills" | "composer.availableSkills") =>
    rows.length
      ? `<section class="creation-skill-option-group"><h3>${e(t(label))}<span>${rows.length}</span></h3>${rows.map(row).join("")}</section>`
      : "";
  return (
    group(chosen, "composer.selectedSkills") + group(available, "composer.availableSkills") ||
    `<p class="creation-skill-picker-hint">${e(t(loading ? "creation.loadingSkill" : query || accept ? "creation.noSkillMatches" : "creation.noSkills"))}</p>`
  );
}
export function creationDiscoverySkill(
  t: Translate,
  entry: CreationSkillEntry,
  selected: readonly CreationSkillSelection[],
) {
  const key = creationSkillKey(entry.reference),
    chosen = selected.some((value) => creationSkillKey(value) === key),
    name = skillText(entry.definition.name);
  const detail = t("creation.skillDetails") + ": " + name,
    action = t(entry.enabled ? (chosen ? "creation.selectedSkill" : "creation.useSkill") : "creation.skillUnavailable"),
    delivery = creationSkillDelivery(t, entry.definition);
  return `<article class="creation-discovery-card"><button type="button" class="creation-discovery-cover" data-skill-action="details" data-skill-key="${e(key)}" aria-label="${e(detail)}" title="${e(detail)}">${creationSkillCover(entry)}<span class="creation-discovery-copy"><span class="creation-discovery-title">${e(name)}</span>${delivery ? `<small class="creation-discovery-delivery">${e(t("creation.documentPlanLabel"))}</small>` : ""}</span></button><button type="button" class="icon-button creation-discovery-add" data-skill-action="add" data-skill-key="${e(key)}" data-skill-id="${e(entry.reference.id)}" aria-pressed="${chosen}" ${entry.enabled ? "" : "disabled"} aria-label="${e(action + ": " + name)}" title="${e(action)}">${codexIcon(chosen ? "check" : "plus")}</button></article>`;
}
export function creationSkillBrowserFrame(t: Translate, titleId: string) {
  return `<header class="composer-panel-heading"><h2 tabindex="-1" id="${titleId}" data-pf-message="creation.addSkill">${e(t("creation.addSkill"))}</h2><button type="button" class="composer-panel-action" data-skill-browser-close data-pf-aria-label="creation.close" aria-label="${e(t("creation.close"))}">${codexIcon("x")}</button></header><div class="creation-skill-browser-search wb-form"><label class="wb-field"><span class="sr-only" data-pf-message="creation.searchSkills">${e(t("creation.searchSkills"))}</span><input type="search" data-skill-search data-pf-placeholder="creation.browserSearchHint" autocomplete="off" placeholder="${e(t("creation.browserSearchHint"))}"></label><div data-skill-categories></div></div><div class="creation-skill-browser-scroll" tabindex="0"><div class="creation-skill-options"></div><p class="creation-skill-picker-hint" role="status" data-skill-browser-error hidden></p><button type="button" class="wb-button" data-skill-action="more" hidden></button></div><footer class="creation-skill-browser-footer"><span class="creation-skill-browser-count" role="status" data-skill-browser-count></span><a href="/skills/writing" aria-label="${e(t("creation.viewAll"))}" title="${e(t("creation.viewAll"))}">${codexIcon("settings")}<span data-pf-message="creation.viewAll">${e(t("creation.viewAll"))}</span></a><button type="button" class="wb-button primary" data-skill-browser-close data-pf-message="creation.doneSelecting">${e(t("creation.doneSelecting"))}</button></footer>`;
}
