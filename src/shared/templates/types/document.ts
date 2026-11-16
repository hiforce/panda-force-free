import type { PortableTemplateTypeAdapter, DocumentLayoutTemplate } from "./contracts.js";
import { PortableTemplateError, templateAssert } from "../portable/errors.js";
import {
  templateField,
  templateList,
  templateObject,
  templateText,
  templateChoice,
  templateUnique,
} from "../portable/validation.js";
import { documentTemplateValues } from "./document-values.js";
import type { PortableTemplateManifest } from "../portable/contracts.js";

export const documentLayoutTemplateAdapter: PortableTemplateTypeAdapter = Object.freeze<PortableTemplateTypeAdapter>({
  templateType: "panda.document-template",
  format: "panda.document-layout/v1",
  adapter: { id: "panda.document-editor", api: 1 },
  parse(value, manifest): DocumentLayoutTemplate {
    const input = templateObject(value, ["syntax", "contentSlots", "content", "instructions"]);
    templateAssert(input.syntax === "markdown");
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
    const content = templateText(input.content, 256000, true),
      allowed = new Set([...contentSlots.map((slot) => slot.id), ...manifest.parameters.map((item) => item.id)]);
    for (const match of content.matchAll(/\{\{([^{}]*)\}\}/g)) templateAssert(allowed.has(match[1]!), "invalidPayload");
    templateAssert(!content.replace(/\{\{[^{}]*\}\}/g, "").includes("{{"), "invalidPayload");
    return {
      kind: "document",
      syntax: "markdown",
      contentSlots,
      content,
      instructions: templateText(input.instructions, 64000, true),
    };
  },
});
/** Rendering substitutes declared values once; inserted prose is never interpreted as another template. */
export function applyDocumentLayout(
  model: DocumentLayoutTemplate,
  manifest: PortableTemplateManifest,
  input: unknown,
): string {
  try {
    const values = documentTemplateValues(model, manifest, input),
      plain = (value: string) => value.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, "\\$&"),
      resolved = new Map([...values].map(([key, item]) => [key, item.rich ? item.value : plain(item.value)]));
    let offset = 0,
      bytes = 0;
    const parts: string[] = [],
      encoder = new TextEncoder(),
      lengths = new Map<string, number>();
    const append = (value: string, identity?: string) => {
      const length =
        identity !== undefined && lengths.has(identity) ? lengths.get(identity)! : encoder.encode(value).length;
      if (identity !== undefined) lengths.set(identity, length);
      bytes += length;
      templateAssert(bytes <= 2 * 1024 * 1024, "invalidParameters");
      parts.push(value);
    };
    for (const match of model.content.matchAll(/\{\{([^{}]*)\}\}/g)) {
      append(model.content.slice(offset, match.index));
      append(resolved.get(match[1]!) || "", match[1]);
      offset = match.index + match[0].length;
    }
    append(model.content.slice(offset));
    return parts.join("");
  } catch {
    throw new PortableTemplateError("invalidParameters");
  }
}
