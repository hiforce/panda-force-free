import type { Translate } from "../../shared/i18n/messages.js";
import type { InstalledPlugin, PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { messageHtml as m } from "../i18n.js";
import { presentationLabel } from "../presentation-labels.js";

export function extensionFrame(t: Translate) {
  const link = (path: string, icon: string, title: "skills" | "publishing") =>
    `<a class="extension-destination" href="${path}" data-wb="route" data-route="${path}">
      <span class="extension-symbol">${codexIcon(icon)}</span><span class="extension-destination-copy">
      <strong>${m(title === "skills" ? "plugins.settingsSkills" : "plugins.settingsPublishing", undefined, t)}</strong>
      <span>${m(title === "skills" ? "plugins.settingsSkillsHint" : "plugins.settingsPublishingHint", undefined, t)}</span>
      <span class="extension-link-label">${m(title === "skills" ? "plugins.settingsOpenSkills" : "plugins.settingsOpenPublish", undefined, t)} ${codexIcon("arrowUpRight")}</span></span></a>`;
  return `<section class="extension-workspace">
    <header class="resource-heading extension-heading"><div><h1>${m("creative.extensions", undefined, t)}</h1>
      <p>${m("plugins.settingsHint", undefined, t)}</p></div>
      <button type="button" class="wb-button primary" data-extension-manage="">${codexIcon("plus")}${m("plugins.settingsImport", undefined, t)}</button></header>
    <div class="extension-destinations">${link("/skills/writing", "sparkles", "skills")}${link("/publish", "send", "publishing")}</div>
    <section class="extension-installed" aria-labelledby="extensionInstalledHeading">
      <header class="extension-list-heading"><div><h2 id="extensionInstalledHeading">${m("plugins.settingsInstalled", undefined, t)} <span class="extension-count" data-extension-count></span></h2>
        <p>${m("plugins.settingsInstalledHint", undefined, t)}</p></div>
        <button type="button" class="wb-button" data-extension-refresh>${codexIcon("refreshCw")}${m("plugins.refresh", undefined, t)}</button></header>
      <p class="extension-notice" role="status" data-extension-notice hidden></p>
      <div data-extension-list aria-busy="true"></div>
    </section></section>`;
}

function packageCard(t: Translate, versions: InstalledPlugin[]) {
  const item = versions.find((p) => p.active) || versions.find((p) => p.enabled) || versions[0]!,
    themes = item.manifest.siteThemes.length,
    styles = item.manifest.channelTemplates.length;
  return `<article class="extension-package" data-extension-package="${e(item.id)}" data-extension-version="${e(item.version)}">
    <span class="extension-symbol">${codexIcon(themes ? "globe" : "file")}</span>
    <div class="extension-package-copy"><div class="extension-package-title"><h3 data-i18n-ignore data-extension-label="name">${e(presentationLabel(t, item.manifest))}</h3>
      <span class="extension-state" data-state="${item.active && item.enabled ? "active" : "inactive"}">${m(item.active && item.enabled ? "plugins.activeVersion" : item.enabled ? "plugins.retainedVersion" : "plugins.disabled", undefined, t)}</span></div>
      <p data-i18n-ignore data-extension-label="description">${e(presentationLabel(t, item.manifest, "description"))}</p>
      <div class="extension-package-meta"><span data-i18n-ignore>v${e(item.version)}</span>
        ${themes ? `<span>${m("plugins.settingsThemes", { count: themes }, t)}</span>` : ""}
        ${styles ? `<span>${m("plugins.settingsStyles", { count: styles }, t)}</span>` : ""}
        ${versions.length > 1 ? `<span>${m("plugins.settingsVersions", { count: versions.length }, t)}</span>` : ""}</div></div>
    <button type="button" class="wb-button" data-extension-manage="${e(item.id)}">${m("plugins.settingsManageVersion", undefined, t)}</button>
    </article>`;
}

export function extensionList(t: Translate, snapshot: PluginRegistrySnapshot | null) {
  if (!snapshot) return `<p class="extension-loading" role="status">${m("plugins.settingsLoading", undefined, t)}</p>`;
  if (snapshot.packages.length) {
    const groups = new Map<string, InstalledPlugin[]>();
    for (const item of [...snapshot.packages].sort((a, b) => b.installedAt - a.installedAt)) {
      if (!groups.has(item.id)) groups.set(item.id, []);
      groups.get(item.id)!.push(item);
    }
    return `<div class="extension-packages">${[...groups.values()].map((items) => packageCard(t, items)).join("")}</div>
      <p class="extension-version-hint">${m("plugins.settingsVersionHint", undefined, t)}</p>`;
  }
  return `<div class="extension-empty"><div class="extension-empty-intro"><span class="extension-symbol">${codexIcon("plug")}</span>
    <div><h3>${m("plugins.settingsEmpty", undefined, t)}</h3><p>${m("plugins.settingsEmptyHint", undefined, t)}</p></div></div>
    <ol class="extension-steps">${(["import", "review", "use"] as const).map((step, index) => `<li><span class="extension-step-number" aria-hidden="true">0${index + 1}</span><div><strong>${m(step === "import" ? "plugins.settingsStepImport" : step === "review" ? "plugins.settingsStepReview" : "plugins.settingsStepUse", undefined, t)}</strong><p>${m(step === "import" ? "plugins.settingsStepImportHint" : step === "review" ? "plugins.settingsStepReviewHint" : "plugins.settingsStepUseHint", undefined, t)}</p></div></li>`).join("")}</ol></div>`;
}
