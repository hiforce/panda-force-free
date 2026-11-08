import { bindMessages, setMessageHtml } from "../i18n.js";

// Sanitize every update while retaining decoded images when surrounding text changes.
/** @param {HTMLElement} element @param {string} html */
export function setConversationContent(element, html) {
  const template = element.ownerDocument.createElement("template");
  const clean = setMessageHtml(template, html);
  if (element.innerHTML === clean) return;
  const images = [...element.querySelectorAll("img.message-image")];
  for (const image of template.content.querySelectorAll("img.message-image")) {
    const index = images.findIndex(
      (previous) =>
        previous.getAttributeNames().length === image.getAttributeNames().length &&
        previous.getAttributeNames().every((name) => previous.getAttribute(name) === image.getAttribute(name)),
    );
    if (index >= 0) image.replaceWith(images.splice(index, 1)[0]);
  }
  element.replaceChildren(template.content);
  if (clean.includes("data-pf-")) bindMessages(element);
}
