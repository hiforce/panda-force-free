import { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import { siteProfileTemplateAdapter } from "../../../shared/templates/types/site.js";
import { documentLayoutTemplateAdapter } from "../../../shared/templates/types/document.js";
import { slidesLayoutTemplateAdapter } from "../../../shared/templates/types/slides.js";
import { richDocumentTemplateData } from "../../../shared/templates/types/document-rich.js";
import type { TemplateDocumentCodec } from "../authoring/ports.js";
import type { RichDocumentLayoutTemplate } from "../../../shared/templates/types/contracts.js";
import { richDocumentInput, richDocumentFromMarkdown } from "../../documents/rich-codec.js";
import { DocumentError } from "../../documents/errors.js";
import { PortableTemplateError } from "../../../shared/templates/portable/errors.js";

function editorValue<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DocumentError) throw new PortableTemplateError("invalidPayload");
    throw error;
  }
}

export const templateDocumentCodec: TemplateDocumentCodec = {
  fromMarkdown: (value) => editorValue(() => richDocumentFromMarkdown(value)),
  normalize: (value) => editorValue(() => richDocumentInput(value).body),
};
/** The composition root supplies editor-schema validation without making template services import document storage. */
export function createPortableTemplateTypes(codec = templateDocumentCodec) {
  return new PortableTemplateTypes([
    siteProfileTemplateAdapter,
    documentLayoutTemplateAdapter,
    slidesLayoutTemplateAdapter,
    {
      ...richDocumentTemplateData,
      parse(value, manifest) {
        const model = richDocumentTemplateData.parse(value, manifest) as RichDocumentLayoutTemplate;
        return { ...model, body: codec.normalize(model.body) };
      },
    },
  ]);
}
