import { normalizeRichBody, richBodyImageIds, type RichDocumentBody } from "../../shared/documents/rich-body.js";
import { richMarkup } from "../../shared/documents/rich-markup.js";
import { setMessageHtml } from "../i18n.js";

/** Reading uses the closed source schema and escaped markup without importing the editing engine. */
export function richDocumentReader(
  body: RichDocumentBody,
  label: string,
  imageUrl: (id: string) => string = (id) => "/api/document-assets/content?id=" + id,
) {
  const normalized = normalizeRichBody(body),
    images = new Map(richBodyImageIds(normalized).map((id) => [id, imageUrl(id)])),
    surface = document.createElement("div"),
    content = document.createElement("div");
  surface.className = "document-rich-surface";
  content.className = "document-rich-content";
  content.contentEditable = "false";
  content.dataset.documentReader = "";
  content.setAttribute("role", "document");
  content.setAttribute("aria-label", label);
  content.setAttribute("data-i18n-ignore", "");
  setMessageHtml(content, richMarkup(normalized, "html", images));
  const wrapper = content.firstElementChild!;
  content.replaceChildren(...wrapper.childNodes);
  for (const link of content.querySelectorAll<HTMLAnchorElement>("a[href]")) link.target = "_blank";
  for (const image of content.querySelectorAll<HTMLImageElement>("img")) {
    image.loading = "lazy";
    image.decoding = "async";
  }
  for (const input of content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    const item = input.parentElement!,
      list = item.parentElement!,
      label = document.createElement("label"),
      box = document.createElement("div");
    item.dataset.type = "taskItem";
    item.dataset.checked = String(input.checked);
    list.dataset.type = "taskList";
    label.append(input, document.createElement("span"));
    box.append(...item.childNodes);
    item.replaceChildren(label, box);
  }
  surface.append(content);
  return surface;
}
