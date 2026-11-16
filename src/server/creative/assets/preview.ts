import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { CreativePreviewResources, type CreativePreviewResource } from "./preview-resources.js";

const tags = new Set(
  "html head body title style main header footer section article nav aside div span p a h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col br hr strong em b i u s small pre code blockquote figure figcaption img details summary time sup sub".split(
    " ",
  ),
);
const attributes = new Set("id class style lang dir title colspan rowspan width height alt".split(" "));
const csp =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>html{color-scheme:light;background:white;color:black}</style>";

/** A static HTML view is deliberately narrower than an executable web application; the caller also applies iframe sandbox. */
export function staticCreativePreview(
  bytes: Uint8Array,
  name = "index.html",
  files: readonly CreativePreviewResource[] = [],
): string | undefined {
  const document = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    resources = new CreativePreviewResources(files);
  let count = 0,
    exceeded = false;
  function visit(parent: DefaultTreeAdapterMap["parentNode"], depth: number) {
    if (++count > 100000 || depth > 128) {
      exceeded = true;
      return false;
    }
    parent.childNodes = parent.childNodes.filter((node) => {
      if (node.nodeName === "#text") return true;
      if (
        "tagName" in node &&
        node.tagName === "link" &&
        node.attrs.some((a) => a.name === "rel" && a.value.toLowerCase() === "stylesheet")
      ) {
        const href = node.attrs.find((a) => a.name === "href")?.value,
          css = href === undefined ? undefined : resources.stylesheet(href, name);
        if (css === undefined) return false;
        node.tagName = node.nodeName = "style";
        node.attrs = [];
        node.childNodes = [{ nodeName: "#text", value: css, parentNode: node }];
      } else if ("tagName" in node && node.tagName === "style") {
        for (const text of node.childNodes)
          if (text.nodeName === "#text" && "value" in text) text.value = resources.css(text.value, name);
      }
      if (!("tagName" in node) || node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !tags.has(node.tagName))
        return false;
      node.attrs = node.attrs.filter((a) => {
        if (a.name === "style") a.value = resources.css(a.value, name);
        if (node.tagName === "img" && a.name === "src") {
          const src = resources.image(a.value, name);
          if (src) a.value = src;
          return !!src;
        }
        return attributes.has(a.name) || (node.tagName === "a" && a.name === "href" && /^#[a-z0-9_-]+$/i.test(a.value));
      });
      return visit(node, depth + 1);
    });
    return true;
  }
  try {
    visit(document, 0);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) return undefined;
    throw error;
  }
  if (exceeded) return undefined;
  const html = serialize(document).replace(/<head[^>]*>/i, (head) => head + csp);
  return Buffer.byteLength(html) <= limits.previewBytes ? html : undefined;
}
