import type { RichTextNode } from "../../documents/rich-body.js";
import { templateImages, templateImageBody, validateTemplateImageFiles } from "../authoring/images.js";
import type { PortableTemplateTypeAdapter, RichDocumentLayoutTemplate } from "./contracts.js";
import { templateAssert } from "../portable/errors.js";
import {
  templateField,
  templateList,
  templateObject,
  templateChoice,
  templateText,
  templateUnique,
} from "../portable/validation.js";

/** Data validation is portable; a host registers its strict editor-schema validator before enabling this format. */
export const richDocumentTemplateData: PortableTemplateTypeAdapter = Object.freeze<PortableTemplateTypeAdapter>({
  templateType: "panda.document-template",
  format: "panda.rich-document-layout/v1",
  adapter: { id: "panda.document-editor", api: 1 },
  parse(value, manifest): RichDocumentLayoutTemplate {
    const input = templateObject(value, ["body", "contentSlots", "instructions", "images"]),
      images = templateImages(input.images ?? []);
    validateTemplateImageFiles(images, manifest);
    const body = templateImageBody(input.body, "read", images);
    const contentSlots = templateList(
      input.contentSlots,
      (value) => {
        const slot = templateObject(value, ["id", "kind", "default"]);
        return {
          id: templateField(slot.id),
          kind: templateChoice(slot.kind, ["rich-text", "plain-text"]),
          default: templateText(slot.default, 64000, true),
        };
      },
      64,
    );
    templateUnique(contentSlots, (item) => item.id);
    templateAssert(contentSlots.every((slot) => !manifest.parameters.some((parameter) => parameter.id === slot.id)));
    const allowed = new Set([
      ...contentSlots.map((slot) => slot.id),
      ...manifest.parameters.map((parameter) => parameter.id),
    ]);
    const visit = (node: RichTextNode) => {
      let text = "";
      const check = () => {
        for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g))
          templateAssert(allowed.has(match[1]!), "unknownPlaceholder");
        templateAssert(!text.replace(/\{\{[^{}]*\}\}/g, "").includes("{{"), "invalidPayload");
        text = "";
      };
      for (const child of node.content || []) {
        if (child.type === "text") text += child.text || "";
        else check();
      }
      check();
      node.content?.forEach(visit);
    };
    visit(body.document);
    return {
      kind: "document",
      syntax: "richtext",
      body,
      images,
      contentSlots,
      instructions: templateText(input.instructions, 64000, true),
    };
  },
});
