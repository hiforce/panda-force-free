import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { setMessageHtml } from "../i18n.js";
import { coverFailed } from "../templates/covers.js";
import { creationSkillCover, skillText, type CreationSkillEntry } from "./skill-views.js";

/** Read-only details preserve the creation dialog, search, selected versions and scroll position. */
export function openCreationSkillDetails(t: Translate, entry: CreationSkillEntry, trigger: HTMLElement) {
  const dialog = document.createElement("dialog"),
    titleId = "creation-skill-details-" + crypto.randomUUID(),
    parent = trigger.closest<HTMLDialogElement>("dialog"),
    container = parent || trigger.closest<HTMLElement>("[data-creative-selected]");
  dialog.className = "workbench-dialog creation-skill-detail";
  dialog.setAttribute("aria-labelledby", titleId);
  const description = skillText(entry.definition.readme || entry.definition.description);
  setMessageHtml(
    dialog,
    `<header><h2 id="${titleId}">${e(t("creation.skillDetails"))}</h2><button type="button" class="wb-button icon-button" data-skill-detail-close aria-label="${e(t("creation.close"))}">${codexIcon("x")}</button></header><div class="creation-skill-detail-body"><div class="creation-skill-detail-intro">${creationSkillCover(entry)}<div><h3>${e(skillText(entry.definition.name))}</h3><p>v${e(entry.reference.version)}</p></div></div><div class="creation-skill-readme">${description
      .split(/\n\s*\n/)
      .map((text) => `<p>${e(text)}</p>`)
      .join(
        "",
      )}</div><dl class="wb-description-list"><dt>${e(t("creation.skillLibrary"))}</dt><dd>${e(skillText(entry.name))}</dd><dt>${e(t("templates.source"))}</dt><dd>${e(t(entry.origin.kind === "builtin" ? "templates.builtinSource" : entry.origin.kind === "github" ? "templates.githubSource" : "templates.uploadSource"))}</dd><dt>${e(t("templates.publisher"))}</dt><dd>${e(entry.publisher)}</dd><dt>${e(t("templates.license"))}</dt><dd>${e(entry.license)}</dd></dl></div>`,
  );
  let disposed = false;
  const close = (restore = true) => {
    if (disposed) return;
    disposed = true;
    dialog.removeEventListener("error", coverFailed, true);
    dialog.close();
    dialog.remove();
    if (restore && container?.isConnected && (!parent || parent.open)) {
      const target = trigger.isConnected
        ? trigger
        : container.querySelector<HTMLElement>(
            `[data-skill-action="details"][data-skill-key="${CSS.escape(JSON.stringify([entry.reference.packageId, entry.reference.version, entry.reference.digest, entry.reference.id]))}"]`,
          );
      (target || container.querySelector<HTMLElement>("[data-skill-browser-open], [data-skill-search]"))?.focus({
        preventScroll: true,
      });
    }
  };
  dialog.querySelector<HTMLButtonElement>("[data-skill-detail-close]")!.onclick = () => close();
  dialog.addEventListener("close", () => close());
  dialog.addEventListener("error", coverFailed, true);
  document.body.append(dialog);
  dialog.showModal();
  return () => close(false);
}
