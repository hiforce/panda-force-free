import type { ContentVariant } from "../../shared/publishing/content.js";
import type { VariantSummary } from "../../shared/publishing/variants.js";

/** History does not need a channel body, HTML preview or complete canonical source snapshot. */
export function variantSummary(variant: ContentVariant): VariantSummary {
  return {
    id: variant.id,
    revisionId: variant.source.revisionId,
    format: variant.format,
    templateId: variant.templateId,
    templateVersion: variant.templateVersion,
    title: variant.title,
    createdAt: variant.createdAt,
  };
}
