import { marked } from "marked";
import type { Translate } from "../../shared/i18n/messages.js";
import type { PortableTemplateModel } from "../../shared/templates/types/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { presentationPreviewFrame } from "../presentation-preview.js";
import { siteProfileSamplePreview } from "../publishing-styles/preview.js";
import { richMarkup } from "../../shared/documents/rich-markup.js";

/** Each trusted model has its own presentation; all rich content still crosses the opaque preview boundary. */
export function portableTemplatePreview(
  host: HTMLElement,
  model: PortableTemplateModel,
  t: Translate,
  images: ReadonlyMap<string, string> = new Map(),
) {
  if (model.kind === "site") return siteProfileSamplePreview(host, model.profile, t);
  if (model.kind === "document") {
    presentationPreviewFrame(
      host,
      `<main style="font:16px/1.8 system-ui,sans-serif;max-width:760px;padding:24px;margin:auto">${model.syntax === "richtext" ? richMarkup(model.body, "html", images) : marked.parse(model.content, { async: false })}</main>`,
      t("templates.structurePreview"),
    );
    return;
  }
  const font = model.theme.font === "serif" ? "Georgia,serif" : "Arial,sans-serif";
  const slides = model.sampleSlides
    .map((slide) => {
      const layout = model.layouts.find((item) => item.id === slide.layout)!;
      return `<section data-slide-layout="${e(layout.id)}" style="padding:32px;margin:0 0 16px;border:1px solid #d0d5dd;background:${e(model.theme.background)};aspect-ratio:${e(model.aspectRatio.replace(":", "/"))};box-sizing:border-box;overflow:auto"><small>${e(layout.id)}</small>${layout.slots.map((slot, index) => (index === 0 ? `<h1 style="color:${e(model.theme.primary)};font-size:28px">${e(slide.values[slot] || "")}</h1>` : `<p style="white-space:pre-wrap">${e(slide.values[slot] || "")}</p>`)).join("")}</section>`;
    })
    .join("");
  presentationPreviewFrame(
    host,
    `<main style="font-family:${font};color:#27313d;max-width:960px;margin:auto;padding:16px">${slides}</main>`,
    t("templates.slidesStructurePreview"),
  );
}
