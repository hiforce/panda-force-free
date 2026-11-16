import { contentSourceScope } from "../../shared/publishing/source-scope.js";
import { randomUUID, createHash } from "node:crypto";
import type { ContentIR, ContentVariant, PublicationFormat } from "../../shared/publishing/content.js";
import { templateDescriptor, type TemplateSelection } from "../../shared/presentation/templates.js";
import type { ContentFormatter } from "./content/formatter.js";
import { contentImages } from "./content/walk.js";

/** Transformations produce immutable channel content without publication permission. */
export function transformContent(
  ir: ContentIR,
  format: PublicationFormat,
  template: TemplateSelection,
  formatter: ContentFormatter,
): ContentVariant {
  const selected = templateDescriptor(template);
  return {
    schema: 1,
    id: randomUUID(),
    source: {
      documentId: ir.documentId,
      revisionId: ir.revisionId,
      sourceHash: ir.sourceHash,
      ...contentSourceScope(ir),
    },
    format,
    mode: "format",
    templateId: selected.id,
    templateSnapshot: selected,
    templateVersion: selected.version,
    templateDigest: createHash("sha256")
      .update(JSON.stringify({ id: selected.id, version: selected.version, style: selected.style }))
      .digest("hex"),
    formatterVersion: formatter.version,
    title: ir.title,
    locale: ir.locale,
    ...formatter.format(ir, selected),
    images: contentImages(ir),
    createdAt: Date.now(),
  };
}
