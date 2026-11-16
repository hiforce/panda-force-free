import { escapeHtml as e } from "../../shared/html.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SiteBuild } from "../../shared/builds/jobs.js";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { messageHtml as m } from "../i18n.js";
import { sourceSnapshot } from "./source-snapshot.js";

import { phaseLabels } from "../build-phase-labels.js";

export const activeBuild = (build: SiteBuild) => !["completed", "failed", "cancelled"].includes(build.phase);
export function buildButton(t: Translate, label: MessageId, action: string, primary = false) {
  return `<button type="button" class="wb-button${primary ? " primary" : ""}" data-build-action="${action}">${m(label, undefined, t)}</button>`;
}
function field(t: Translate, key: string, label: MessageId, value: string, extra = "") {
  return `<label for="build-${key}">${m(label, undefined, t)}</label><input id="build-${key}" name="site-${key}" value="${e(value)}" ${extra}>`;
}
export function buildFrame(t: Translate, space: DocumentSpace) {
  return `<header class="builds-heading"><div><span>${m("builds.title", undefined, t)}</span><h2 data-i18n-ignore>${e(space.name)}</h2></div>${buildButton(t, "builds.close", "close")}</header>
    <div class="builds-layout"><aside class="builds-sidebar"><details class="builds-settings" open><summary>${m("builds.settings", undefined, t)}</summary><form id="siteBuildForm">
    <label for="build-engine">${m("builds.engine", undefined, t)}</label><select id="build-engine" name="site-engine"><option value="hexo" ${space.engine !== "docusaurus" ? "selected" : ""}>Hexo</option><option value="docusaurus" ${space.engine === "docusaurus" ? "selected" : ""}>Docusaurus</option></select>
    <span class="builds-field-label">${m("documents.theme", undefined, t)}</span><span id="buildPreset"></span>${buildButton(t, "builds.chooseTheme", "theme")}<p id="buildThemeHint"></p>
    ${field(t, "title", "builds.siteTitle", space.name, 'required maxlength="200"')}
    ${field(t, "locale", "builds.locale", space.locale, 'required maxlength="35"')}
    ${field(t, "url", "builds.siteUrl", "https://example.com", 'type="url" required maxlength="500"')}
    ${field(t, "basePath", "builds.basePath", "/", 'required maxlength="160"')}
    <p>${m("builds.savedOnly", undefined, t)}</p><button type="submit" class="wb-button primary" id="createSiteBuild" disabled>${m("builds.build", undefined, t)}</button>
    </form></details><div id="buildAvailability" role="status"></div><div class="builds-history-heading"><h3>${m("builds.history", undefined, t)}</h3>${buildButton(t, "builds.refresh", "refresh")}</div><div id="buildHistory"></div></aside>
    <section class="builds-main"><p id="buildNotice" role="status"></p><div id="buildDetail"><div class="builds-empty">${m("builds.selectBuild", undefined, t)}</div></div></section></div>
    <footer class="builds-footer">${m("builds.retentionNotice", undefined, t)}</footer>`;
}
export function buildHistory(t: Translate, jobs: SiteBuild[], selected: string) {
  if (!jobs.length) return `<p>${m("builds.noBuilds", undefined, t)}</p>`;
  return jobs
    .map(
      (job) =>
        `<button type="button" class="builds-history-row ${job.id === selected ? "selected" : ""}" data-build-action="select" data-id="${e(job.id)}" ${job.id === selected ? 'aria-current="true"' : ""}><span>${e(job.site.title)}</span><small>${e(new Date(job.createdAt).toLocaleString())} · ${e(job.engine)}</small><span class="builds-phase" data-phase="${job.phase}">${m(phaseLabels[job.phase], undefined, t)}</span></button>`,
    )
    .join("");
}
export function buildDetail(t: Translate, job: SiteBuild) {
  return `<div class="builds-summary"><div><h3>${e(job.site.title)}</h3><span class="builds-phase" data-phase="${job.phase}">${m(phaseLabels[job.phase], undefined, t)}</span><p>${m("builds.documentsSummary", { count: job.sources.length }, t)} · ${e(job.site.locale)}</p></div><div class="builds-actions">${activeBuild(job) ? buildButton(t, "builds.cancel", "cancel") : buildButton(t, "builds.delete", "delete")}${job.artifactAvailable ? buildButton(t, "builds.download", "download", true) : ""}</div></div>
    ${job.connection === "retrying" ? `<p class="builds-retrying">${m("builds.retrying", undefined, t)}</p>` : ""}
    ${job.artifactAvailable ? `<div class="builds-actions">${buildButton(t, "delivery.title", "publish", true)}</div>` : ""}
    <p id="buildError" role="status" ${job.error && job.connection !== "retrying" ? "" : "hidden"}></p>
    <div id="buildDeleteConfirm" class="builds-delete-confirm" hidden><p>${m("builds.deleteConfirm", undefined, t)}</p>${buildButton(t, "builds.keepBuild", "keep")}${buildButton(t, "builds.confirmDelete", "confirm-delete")}</div>
    ${job.phase === "completed" ? `<p>${job.artifactAvailable ? m("builds.outputSummary", { count: job.fileCount, size: (job.outputBytes / 1048576).toFixed(2) }, t) : m("builds.artifactExpired", undefined, t)}</p>` : ""}
    <div class="builds-tabs" role="group">${job.artifactAvailable ? buildButton(t, "builds.preview", "preview") : ""}${buildButton(t, "builds.logs", "logs")}${buildButton(t, "builds.snapshot", "snapshot")}</div>
    <section id="buildPreviewPane" hidden><p>${m("builds.previewNotice", undefined, t)}</p><div id="buildPreviewMount"></div></section>
    <pre id="buildLogPane" class="builds-log" data-i18n-ignore></pre>
    <section id="buildSnapshotPane" hidden>${job.nativeTheme ? `<h4>${m("builds.themeSnapshot", undefined, t)}</h4><p><code>${e(job.nativeTheme.id)} @ ${e(job.nativeTheme.version)}</code></p><code>${e(job.nativeTheme.digest)}</code>` : job.theme ? `<h4>${m("builds.themeSnapshot", undefined, t)}</h4><p><code>${e(job.theme.id)} @ ${e(job.theme.version)}</code></p><code>${e(job.theme.sha256)}</code>` : `<p>${m("builds.themeLegacy", undefined, t)}</p>`}<table><thead><tr><th>${m("builds.sourcePath", undefined, t)}</th><th>${m("builds.revision", undefined, t)}</th></tr></thead><tbody>${job.sources.map((source) => `<tr><td data-i18n-ignore>${e(source.path)}</td><td><code>${e(source.revisionId)}</code></td></tr>`).join("")}</tbody></table>${sourceSnapshot(t, job.project)}${job.image ? `<h4>${m("builds.image", undefined, t)}</h4><code>${e(job.image.reference)}<br>${e(job.image.id)}</code>` : ""}</section>`;
}
