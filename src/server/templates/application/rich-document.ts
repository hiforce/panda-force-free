import type { RichTextNode, RichDocumentBody } from "../../../shared/documents/rich-body.js";
import { RICH_DOCUMENT_LIMITS } from "../../../shared/documents/rich-body.js";
import type { RichDocumentLayoutTemplate } from "../../../shared/templates/types/contracts.js";
import type { PortableTemplateManifest } from "../../../shared/templates/portable/contracts.js";
import { documentTemplateValues } from "../../../shared/templates/types/document-values.js";
import { templateAssert, PortableTemplateError } from "../../../shared/templates/portable/errors.js";
import type { TemplateDocumentCodec } from "../authoring/ports.js";

/** Replace text runs across marks, retaining the native tree and parsing only explicitly rich content slots. */
export function applyRichDocumentTemplate(
  model: RichDocumentLayoutTemplate,
  manifest: PortableTemplateManifest,
  input: unknown,
  codec: TemplateDocumentCodec,
): RichDocumentBody {
  try {
    const values = documentTemplateValues(model, manifest, input),
      rich = new Map<string, RichTextNode[]>(),
      encoder = new TextEncoder();
    let nodes = 0,
      bytes = 0;
    for (const [key, value] of values)
      if (value.rich) rich.set(key, codec.fromMarkdown(value.value).document.content || []);
    const own = (node: RichTextNode): RichTextNode => {
      templateAssert(++nodes <= RICH_DOCUMENT_LIMITS.nodes, "invalidParameters");
      if (node.text) {
        bytes += encoder.encode(node.text).length;
        templateAssert(bytes <= RICH_DOCUMENT_LIMITS.bytes, "invalidParameters");
      }
      return {
        ...structuredClone({ ...node, content: undefined }),
        ...(node.content ? { content: node.content.map(own) } : {}),
      };
    };
    const replaceRun = (run: RichTextNode[], literal = false) => {
      const text = run.map((node) => node.text || "").join(""),
        output: RichTextNode[] = [];
      let at = 0,
        start = 0;
      const advance = (offset: number) => {
        while (at < run.length && start + run[at]!.text!.length <= offset) {
          start += run[at]!.text!.length;
          at++;
        }
      };
      const slice = (from: number, to: number) => {
        advance(from);
        let offset = from;
        while (at < run.length && offset < to) {
          const node = run[at]!,
            end = Math.min(to, start + node.text!.length),
            selected = node.text!.slice(offset - start, end - start);
          if (selected) output.push(own({ ...node, text: selected }));
          offset = end;
          advance(offset);
        }
      };
      let cursor = 0;
      for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
        slice(cursor, match.index);
        const key = match[1]!,
          value = values.get(key);
        templateAssert(value, "invalidParameters");
        advance(match.index);
        const marks = run[at]?.marks;
        if (literal) {
          if (value.value) output.push(own({ type: "text", text: value.value, ...(marks ? { marks } : {}) }));
        } else if (value.rich) {
          const blocks = rich.get(key)!;
          templateAssert(blocks.length === 1 && blocks[0]!.type === "paragraph", "invalidParameters");
          for (const node of blocks[0]!.content || []) {
            const merged = new Map((marks || []).map((mark) => [mark.type, mark]));
            for (const mark of node.marks || []) merged.set(mark.type, mark);
            output.push(own({ ...node, ...(merged.size ? { marks: [...merged.values()] } : {}) }));
          }
        } else if (value.value) {
          const lines = value.value.split("\n");
          lines.forEach((line, index) => {
            if (index) output.push(own({ type: "hardBreak" }));
            if (line) output.push(own({ type: "text", text: line, ...(marks ? { marks } : {}) }));
          });
        }
        cursor = match.index + match[0].length;
        advance(cursor);
      }
      slice(cursor, text.length);
      return output;
    };
    const visit = (node: RichTextNode): RichTextNode[] => {
      if (!node.content) return [own(node)];
      const children = node.content;
      if (node.type === "paragraph" && children.every((child) => child.type === "text")) {
        const match = /^\{\{([^{}]*)\}\}$/.exec(children.map((child) => child.text || "").join(""));
        if (match && rich.has(match[1]!)) return rich.get(match[1]!)!.map(own);
      }
      templateAssert(++nodes <= RICH_DOCUMENT_LIMITS.nodes, "invalidParameters");
      const content: RichTextNode[] = [];
      let run: RichTextNode[] = [];
      const flush = () => {
        content.push(...replaceRun(run, node.type === "codeBlock"));
        run = [];
      };
      for (const child of children) {
        if (child.type === "text") run.push(child);
        else {
          flush();
          content.push(...visit(child));
        }
      }
      flush();
      return [{ ...structuredClone({ ...node, content: undefined }), content }];
    };
    return codec.normalize({ ...model.body, document: visit(model.body.document)[0] });
  } catch {
    throw new PortableTemplateError("invalidParameters");
  }
}
