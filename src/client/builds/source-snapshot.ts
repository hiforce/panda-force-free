import type { BuildProjectMetadata } from "../../shared/builds/project.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

/** Inspection receives hashes and bounded public configuration, never asset or theme package bytes. */
export function sourceSnapshot(t: Translate, project: BuildProjectMetadata | undefined) {
  if (!project) return "";
  return `<section class="builds-source-snapshot"><h4>${m("builds.sourceProjectSnapshot", undefined, t)}</h4><details><summary>${m("builds.publicSiteSettings", undefined, t)}</summary><pre data-i18n-ignore>${e(JSON.stringify(project.config, null, 2))}</pre></details><details><summary>${m("builds.sourceResources", { count: project.files.length }, t)}</summary><div class="builds-source-files"><table><thead><tr><th>${m("builds.sourcePath", undefined, t)}</th><th>${m("builds.sourceUse", undefined, t)}</th><th>SHA-256</th></tr></thead><tbody>${project.files.map((file) => `<tr><td><code>${e(file.path)}</code></td><td>${m(file.publish ? "builds.resourcePublic" : "builds.resourceBuildOnly", undefined, t)}</td><td><code>${e(file.sha256)}</code></td></tr>`).join("")}</tbody></table></div></details></section>`;
}
