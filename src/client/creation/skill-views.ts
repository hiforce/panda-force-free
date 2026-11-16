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
  return `<article class="creative-skill-chip" data-selected-skill="${e(selection.id)}"><button type="button" class="creative-skill-preview" data-skill-action="details" data-skill-key="${e(creationSkillKey(selection))}" aria-label="${e(t("creation.skillDetails") + ": " + name)}" ${entry ? "" : "disabled"}><span class="creative-skill-art" aria-hidden="true">${entry ? creationSkillCover(entry) : codexIcon("file")}</span><span class="creative-skill-label"><strong title="${e(name)}">${e(name)}</strong><small>v${e(selection.version)}</small></span></button><button type="button" class="creative-skill-remove" data-skill-action="remove" data-index="${index}" data-creative-remove-skill="${index}" aria-label="${e(t("creation.removeSkill") + ": " + name)}">${codexIcon("x")}</button></article>`;
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
  return `<article class="creation-skill" data-selected-skill="${e(selection.id)}"><div class="creation-skill-header"><span class="creation-skill-thumbnail" aria-hidden="true">${entry ? creationSkillCover(entry) : codexIcon("file")}</span><div class="creation-skill-copy"><strong>${e(entry ? skillText(entry.definition.name) : selection.id)}</strong><small>v${e(selection.version)}</small>${!entry || !entry.enabled ? `<span class="creation-skill-availability">${e(t(loading && !entry ? "creation.loadingSkill" : "creation.skillUnavailable"))}</span>` : ""}</div>${detailsButton(t, entry, creationSkillKey(selection))}</div>${parameters ? `<details data-skill-key="${e(creationSkillKey(selection))}"><summary>${e(t("creation.parameters"))}${codexIcon("chevronDown")}</summary><div class="wb-form creation-skill-parameters">${parameters}</div></details>` : ""}<div class="creation-skill-actions">${action("up", t("creation.moveEarlier"), index === 0)}${action("down", t("creation.moveLater"), index === count - 1)}${action("remove", t("creation.removeSkill"))}</div></article>`;
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
  return (
    matches
      .map(({ entry, index }) => {
        const chosen = selected.some((value) => creationSkillKey(value) === creationSkillKey(entry.reference)),
          name = skillText(entry.definition.name);
        return `<article class="creation-skill-option" data-selected="${chosen}"><button type="button" class="creation-skill-choose" data-skill-action="add" data-skill-key="${e(creationSkillKey(entry.reference))}" data-skill-package="${e(entry.reference.packageId)}" data-skill-id="${e(entry.reference.id)}" data-index="${index}" aria-pressed="${chosen}" aria-label="${e(t(chosen ? "creation.removeSkill" : "creation.selectSkill") + ": " + name)}" ${entry.enabled ? "" : "disabled"}>${creationSkillCover(entry)}<span class="creation-skill-option-title">${e(name)}</span><span class="creation-skill-check" aria-hidden="true">${chosen ? codexIcon("check") : codexIcon("plus")}</span></button><footer><small>v${e(entry.reference.version)}</small>${detailsButton(t, entry, creationSkillKey(entry.reference))}</footer>${!entry.enabled ? `<small class="creation-skill-availability">${e(t("creation.skillUnavailable"))}</small>` : ""}</article>`;
      })
      .join("") ||
    `<p class="creation-skill-picker-hint">${e(t(loading ? "creation.loadingSkill" : query || accept ? "creation.noSkillMatches" : "creation.noSkills"))}</p>`
  );
}
export function creationSkillBrowserFrame(t: Translate, titleId: string) {
  return `<header class="creation-heading"><div><h2 id="${titleId}">${e(t("creation.browseSkills"))}</h2><p>${e(t("creation.browserHint"))}</p></div><button type="button" class="wb-button icon-button" data-skill-browser-close aria-label="${e(t("creation.close"))}">${codexIcon("x")}</button></header><div class="creation-skill-browser-search wb-form"><label class="wb-field"><span class="sr-only">${e(t("creation.searchSkills"))}</span><input type="search" data-skill-search autocomplete="off" placeholder="${e(t("creation.browserSearchHint"))}"></label><div data-skill-categories></div></div><div class="creation-skill-browser-scroll" tabindex="0"><div class="creation-skill-options"></div><p class="creation-skill-picker-hint" role="status" data-skill-browser-error hidden></p><button type="button" class="wb-button" data-skill-action="more" hidden></button></div><footer class="creation-skill-browser-footer"><span class="creation-skill-browser-count" role="status" data-skill-browser-count></span><a href="/skills/writing" aria-label="${e(t("creation.viewAll"))}" title="${e(t("creation.viewAll"))}">${codexIcon("settings")}<span>${e(t("creation.viewAll"))}</span></a><button type="button" class="wb-button primary" data-skill-browser-close>${e(t("creation.doneSelecting"))}</button></footer>`;
}
