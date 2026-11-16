import type { PortableTemplateTypeAdapter, SlidesLayoutTemplate } from "./contracts.js";
import { templateAssert } from "../portable/errors.js";
import {
  templateObject,
  templateChoice,
  templateList,
  templateField,
  templateText,
  templateUnique,
} from "../portable/validation.js";

function color(value: unknown) {
  const color = templateText(value, 7);
  templateAssert(/^#[a-f0-9]{6}$/i.test(color));
  return color;
}
export const slidesLayoutTemplateAdapter: PortableTemplateTypeAdapter = Object.freeze<PortableTemplateTypeAdapter>({
  templateType: "panda.slides-template",
  format: "panda.slides-layout/v1",
  adapter: { id: "panda.slides-editor", api: 1 },
  parse(value, manifest): SlidesLayoutTemplate {
    const input = templateObject(value, ["aspectRatio", "theme", "layouts", "sampleSlides", "editableSource"]),
      theme = templateObject(input.theme, ["primary", "background", "font"]);
    templateAssert(input.editableSource === "structured-slides");
    const aspectRatio = templateChoice(input.aspectRatio, ["16:9", "4:3", "9:16", "1:1"]);
    const layouts = templateList(
      input.layouts,
      (value) => {
        const item = templateObject(value, ["id", "slots"]);
        const slots = templateList(item.slots, templateField, 16, 1);
        templateUnique(slots, (item) => item);
        templateAssert(!slots.includes("layout"));
        return { id: templateField(item.id), slots };
      },
      64,
      1,
    );
    templateUnique(layouts, (item) => item.id);
    const sampleSlides = templateList(
      input.sampleSlides,
      (value) => {
        const row = templateObject(value, ["layout", ...new Set(layouts.flatMap((item) => item.slots))]);
        const layout = layouts.find((item) => item.id === row.layout);
        templateAssert(layout);
        templateObject(row, ["layout", ...layout.slots]);
        const values: Record<string, string> = {};
        for (const name of layout.slots)
          values[name] = row[name] === undefined ? "" : templateText(row[name], 4000, true);
        return { layout: layout.id, values };
      },
      32,
      1,
    );
    const ratio = manifest.parameters.find((item) => item.id === "aspect_ratio");
    templateAssert(
      !ratio ||
        (ratio.type === "choice" &&
          ratio.options.some((item) => item.value === aspectRatio) &&
          (ratio.default === undefined || ratio.default === aspectRatio)),
    );
    return {
      kind: "slides",
      aspectRatio,
      theme: {
        primary: color(theme.primary),
        background: color(theme.background),
        font: templateChoice(theme.font, ["sans", "serif"]),
      },
      layouts,
      sampleSlides,
      editableSource: "structured-slides",
    };
  },
});
