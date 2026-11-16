import { sanitizeRichText } from "./html-safety.js";

/** A preview is an opaque document: no scripts, forms, application cookies or remote assets. */
export function presentationPreviewFrame(host: HTMLElement, html: string, title: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.title = title;
  frame.srcdoc =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'"></head><body>' +
    sanitizeRichText(html, { allowStyles: true }) +
    "</body></html>";
  host.replaceChildren(frame);
}
