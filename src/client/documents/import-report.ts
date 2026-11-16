import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { DocumentImportIssue } from "../../shared/documents/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml } from "../i18n.js";

const reasons: Record<DocumentImportIssue["code"], MessageId> = {
  imageExternal: "documents.imageExternal",
  imageUnsupported: "documents.imageUnsupported",
  imageUnavailable: "documents.imageUnavailable",
  imageMissing: "documents.imageMissing",
  imageAmbiguous: "documents.imageAmbiguous",
  imageLimit: "documents.imageLimit",
};
/** Source paths and references are untrusted labels; reports never become executable markup. */
export function importReport(t: Translate, imported: number, issues: DocumentImportIssue[]) {
  return `<p>${messageHtml("documents.imageImportSummary", { count: imported }, t)}</p><p>${messageHtml("documents.importImageHint", undefined, t)}</p>${issues.length ? `<ul class="document-import-issues">${issues.map((issue) => `<li><strong data-i18n-ignore>${e(issue.path)}</strong><code data-i18n-ignore>${e(issue.source)}</code><span>${messageHtml(reasons[issue.code], undefined, t)}</span></li>`).join("")}</ul>` : `<p>${messageHtml("documents.imageImportComplete", undefined, t)}</p>`}`;
}
