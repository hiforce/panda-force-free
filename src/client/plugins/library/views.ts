import type { Translate, MessageId } from "../../../shared/i18n/messages.js";
import type {
  TemplateLibrarySnapshot,
  TemplateDraft,
  TemplateValidation,
  TemplateRelease,
} from "../../../shared/plugins/library.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { messageHtml as m } from "../../i18n.js";
export const libraryButton = (t: Translate, key: MessageId, action: string, extra = "") =>
  `<button type="button" class="wb-button" data-library-action="${action}" ${extra}>${m(key, undefined, t)}</button>`;
export const fixtureState: Record<NonNullable<TemplateValidation>["results"][number]["state"], MessageId> = {
  passed: "plugins.libraryPassed",
  unreviewed: "plugins.libraryUnreviewed",
  mismatch: "plugins.libraryMismatch",
  blocked: "plugins.libraryBlocked",
  requiresBuild: "plugins.libraryRequiresBuild",
};
export function libraryFrame(t: Translate) {
  return `<header><div><h2>${m("plugins.libraryTitle", undefined, t)}</h2><p>${m("plugins.librarySubtitle", undefined, t)}</p></div>${libraryButton(t, "plugins.close", "close")}</header><p id="libraryNotice" role="status"></p><div class="template-library-layout"><aside><div class="library-list-actions">${libraryButton(t, "plugins.libraryNew", "new")}${libraryButton(t, "plugins.refresh", "refresh")}</div><details class="library-browser" open><summary>${m("plugins.libraryBrowse", undefined, t)}</summary><div><label for="librarySearch">${m("plugins.librarySearch", undefined, t)}</label><input type="search" id="librarySearch">${libraryButton(t, "plugins.libraryImport", "import")}<input type="file" id="libraryImport" accept="application/json,.json" hidden><div id="libraryList"></div></div></details></aside><main><div id="libraryDiscard" class="library-warning" hidden><p>${m("plugins.libraryDiscardHint", undefined, t)}</p>${libraryButton(t, "plugins.libraryKeepEditing", "keep")}${libraryButton(t, "plugins.libraryDiscard", "discard")}</div><div id="libraryEditorEmpty">${m("plugins.librarySelect", undefined, t)}</div><div id="libraryContent" hidden><div class="library-editor-actions">${libraryButton(t, "plugins.librarySave", "save")}${libraryButton(t, "plugins.libraryPreview", "preview")}${libraryButton(t, "plugins.libraryValidate", "validate")}${libraryButton(t, "plugins.libraryPublish", "review")}${libraryButton(t, "plugins.libraryExport", "export")}</div><div id="librarySavedState" role="status"></div><div id="libraryReport"></div><div id="libraryPreview"></div><div id="libraryApproval"></div><div id="libraryEditor"></div><section class="library-version-tools"><label for="libraryNextVersion">${m("plugins.libraryNextVersion", undefined, t)}</label><input id="libraryNextVersion" maxlength="14" placeholder="1.0.1">${libraryButton(t, "plugins.libraryFork", "fork")}${libraryButton(t, "plugins.libraryDeleteDraft", "delete")}<div id="libraryDeleteConfirm" hidden><p>${m("plugins.libraryDeleteHint", undefined, t)}</p>${libraryButton(t, "plugins.libraryDeleteConfirm", "confirm-delete")}${libraryButton(t, "plugins.libraryKeepEditing", "cancel-delete")}</div></section></div></main></div>`;
}
export function libraryList(t: Translate, snapshot: TemplateLibrarySnapshot, query: string) {
  const match = (name: string, id: string) => `${name} ${id}`.toLowerCase().includes(query.toLowerCase());
  return `<h3>${m("plugins.libraryDrafts", undefined, t)}</h3>${snapshot.drafts
    .filter((d) => match(d.manifest.name, d.manifest.id))
    .map(
      (d) =>
        `<button type="button" class="library-entry" data-library-action="select" data-id="${e(d.id)}"><strong>${e(d.manifest.name)}</strong><code>${e(d.manifest.id)}@${e(d.manifest.version)}</code><span>${m(d.publishedAt !== null ? "plugins.libraryPublishedState" : d.validation?.passed ? "plugins.libraryPassed" : "plugins.libraryDraft", undefined, t)}</span></button>`,
    )
    .join("")}<h3>${m("plugins.libraryReleases", undefined, t)}</h3>${snapshot.releases
    .filter((d) => match(d.manifest.name, d.id))
    .map(
      (d) =>
        `<button type="button" class="library-entry" data-library-action="release" data-id="${e(d.id)}" data-version="${e(d.version)}"><strong>${e(d.manifest.name)}</strong><code>${e(d.id)}@${e(d.version)}</code><span>${e(d.archive.author)} · ${e(d.archive.license)}</span></button>`,
    )
    .join("")}`;
}
export function validationReport(t: Translate, current: TemplateDraft | null, release: TemplateRelease | null) {
  const report = current?.validation || release?.validation;
  if (!report) return `<p>${m("plugins.libraryValidationHint", undefined, t)}</p>`;
  return `<section class="library-validation"><h3>${m(report.passed ? "plugins.libraryPassed" : "plugins.libraryNeedsReview", undefined, t)}</h3><ul>${report.results.map((r) => `<li><code>${e(r.fixtureId)}</code> · ${m(fixtureState[r.state], undefined, t)}</li>`).join("")}</ul>${report.missingCoverage.length ? `<p>${m("plugins.libraryMissingCoverage", undefined, t)}</p><ul>${report.missingCoverage.map((key) => `<li><code>${e(key)}</code></li>`).join("")}</ul>` : ""}</section>`;
}
