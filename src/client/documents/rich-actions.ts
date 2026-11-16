import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { messageHtml, messageAttributes } from "../i18n.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

/** All editor surfaces use the same action IDs and labels; providers must supply real commands before adding actions. */
export const richActions = [
  { id: "bold", label: "documents.formatBold", icon: "bold" },
  { id: "italic", label: "documents.formatItalic", icon: "italic" },
  { id: "underline", label: "documents.formatUnderline", icon: "underline" },
  { id: "strike", label: "documents.formatStrike", icon: "strikethrough" },
  { id: "bulletList", label: "documents.formatBulletList", icon: "list" },
  { id: "orderedList", label: "documents.formatOrderedList", icon: "listOrdered" },
  { id: "taskList", label: "documents.formatTaskList", icon: "listChecks" },
  { id: "blockquote", label: "documents.formatQuote", icon: "quote" },
  { id: "codeBlock", label: "documents.formatCodeBlock", icon: "code" },
  { id: "link", label: "documents.formatLink", icon: "link" },
  { id: "image", label: "documents.formatImage", icon: "image" },
  { id: "table", label: "documents.formatTable", icon: "table" },
] as const satisfies readonly { id: string; label: MessageId; icon: string }[];
export type RichActionId = (typeof richActions)[number]["id"];
export function richActionButton(t: Translate, id: RichActionId, attribute = "data-rich-action", text = false) {
  const item = richActions.find((item) => item.id === id)!;
  return `<button type="button" class="document-format-button" ${attribute}="${id}" ${messageAttributes("aria-label", item.label, undefined, t)} ${messageAttributes("title", item.label, undefined, t)}>${codexIcon(item.icon)}${text ? messageHtml(item.label, undefined, t) : ""}</button>`;
}
export function richHeadingSelect(t: Translate, attribute = "data-rich-heading") {
  return `<select ${attribute} ${messageAttributes("aria-label", "documents.formatParagraph", undefined, t)}>${["formatParagraph", "formatHeading1", "formatHeading2", "formatHeading3", "formatHeading4", "formatHeading5", "formatHeading6"].map((key, index) => `<option value="${index}" data-pf-message="documents.${key}">${escapeHtml(t(("documents." + key) as MessageId))}</option>`).join("")}</select>`;
}
