import type { ContentVariant } from "../../shared/publishing/content.js";
import type { VariantDetail } from "../../shared/publishing/variants.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { setMessageHtml } from "../i18n.js";
import { sanitizeRichText } from "../html-safety.js";
import { postPreview } from "./views.js";

/** Rewrite owned image URLs in an inert fragment before it is attached, preserving canonical snapshot bytes. */
export function renderVariantPreview(
  host: HTMLElement,
  detail: VariantDetail,
  t: Translate,
  imageUrl?: (id: string) => string,
) {
  const variant: ContentVariant = detail.variant;
  if (!variant.posts.length && variant.format === "plain") {
    const text = document.createElement("pre");
    text.className = "publishing-plain";
    text.textContent = variant.text;
    host.replaceChildren(text);
    return;
  }
  const fragment = document.createElement("template");
  setMessageHtml(
    fragment,
    variant.posts.length ? postPreview(t, detail) : sanitizeRichText(variant.html, { allowStyles: true }),
  );
  if (imageUrl)
    for (const image of fragment.content.querySelectorAll<HTMLImageElement>("img[src]")) {
      const match = /^\/api\/document-assets\/content\?id=([a-f0-9-]{36})$/i.exec(image.getAttribute("src") ?? "");
      if (match) image.setAttribute("src", imageUrl(match[1]!));
    }
  host.replaceChildren(fragment.content);
}
