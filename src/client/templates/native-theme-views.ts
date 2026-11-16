import type { NativeThemeProposal, NativeThemeReview } from "../../shared/templates/native/contracts.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";

const field = (t: Translate, name: string, label: MessageId, value: string, required = true) =>
  `<label class="wb-field"><span>${e(t(label))}</span><input data-native-field="${name}" value="${e(value)}" ${required ? "required" : ""} autocomplete="off"></label>`;
export function nativeThemeForm(t: Translate, value: NativeThemeProposal, root: string) {
  const settings = value.settings;
  return `<section class="template-source-panel native-theme-import"><header><h3>${e(t("templates.nativeInstallTitle"))}</h3><span>${e(settings.engine)}</span></header><p>${e(t("templates.nativePrivateHint"))}</p>${value.bundle ? `<p>${e(t("templates.nativeBundleHint"))}</p>` : ""}<code>${e(root || "/")}</code>
  ${value.issues.map((issue) => `<p class="source-issue">${e(issue.path)}: ${e(t(`sources.${issue.code}`))}</p>`).join("")}
  <details><summary>${e(t("templates.nativeReadme"))}</summary><pre>${e(value.readmeText || t("templates.notDeclared"))}</pre></details>
  <details><summary>${e(t("templates.licenseText"))} · ${e(settings.license.file || t("templates.notDeclared"))}</summary><pre>${e(value.licenseText || t("templates.notDeclared"))}</pre></details>
  <form class="wb-form" data-native-settings><div class="wb-form-grid">${field(t, "id", "templates.draftId", settings.id)}${field(t, "version", "templates.version", settings.version)}${field(t, "name", "templates.draftName", settings.name.en || "")}${field(t, "publisher", "templates.publisher", settings.publisher)}${field(t, "license", "templates.license", settings.license.expression)}
  <label class="wb-field"><span>${e(t("templates.nativeLicenseFile"))}</span><input data-native-field="licenseFile" list="nativeLicenseFiles" value="${e(settings.license.file)}" required autocomplete="off"><datalist id="nativeLicenseFiles">${value.licenseFiles.map((path) => `<option value="${e(path)}"></option>`).join("")}</datalist></label></div>
  <details><summary>${e(t("templates.nativeAdvanced"))}</summary>${field(t, "description", "templates.draftDescription", settings.description.en || "")}${field(t, "readme", "templates.nativeReadmeFile", settings.readme || "", false)}${settings.engine === "docusaurus" ? field(t, "entry", "templates.nativeEntry", settings.entry || "") : ""}<label class="wb-field"><span>${e(t("templates.nativeDependencies"))}</span><textarea data-native-field="dependencies" rows="4" spellcheck="false">${e(JSON.stringify(settings.dependencies, null, 2))}</textarea></label><p>${e(t("templates.nativeDependenciesHint"))}</p></details>
  <button class="wb-button" type="submit">${e(t("templates.nativeReview"))}</button></form><p role="status" data-native-notice></p><div data-native-approval></div></section>`;
}
export function nativeThemeApproval(t: Translate, review: NativeThemeReview) {
  const settings = review.descriptor.settings;
  return `<div class="package-review"><h3>${e(settings.name.en!)} · ${e(settings.version)}</h3><p>${e(settings.license.expression)} · ${e(settings.engine)}</p><h4>${e(t("templates.nativeCodePermission"))}</h4><p>${e(t("templates.nativeCodeHint"))}</p><details open><summary>${e(t("templates.licenseText"))}</summary><pre>${e(review.licenseText)}</pre></details><details><summary>${e(t("templates.identity"))}</summary><code>${e(review.descriptor.source.digest)}</code><p><code>${e(review.digest)}</code></p></details>
  <form class="wb-form" data-native-accept><label class="wb-choice"><input data-native-code type="checkbox" required>${e(t("templates.nativeApproveCode"))}</label><label class="wb-choice"><input data-native-license type="checkbox" required>${e(t("templates.nativeApproveLicense"))}</label><button type="submit" class="wb-button primary">${e(t("templates.nativeInstall"))}</button></form></div>`;
}
