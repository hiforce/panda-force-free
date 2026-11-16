import type { RichDocumentBody } from "./rich-body.js";
import { richMarkup } from "./rich-markup.js";
export { RichMarkupError as RichSiteError } from "./rich-markup.js";

/** Site engines select a projection dialect; the same neutral renderer also serves local reading. */
export function richSiteContent(
  body: RichDocumentBody,
  engine: "hexo" | "docusaurus",
  images: ReadonlyMap<string, string>,
) {
  return richMarkup(body, engine === "docusaurus" ? "jsx" : "html", images);
}
