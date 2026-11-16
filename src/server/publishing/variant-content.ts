import { createHash } from "node:crypto";
import type { ContentIR, ContentVariant } from "../../shared/publishing/content.js";

export interface VariantContent {
  variant: ContentVariant;
  ir: ContentIR;
}
export interface VariantContents {
  put(content: VariantContent): Promise<string>;
  read(digest: string): Promise<VariantContent>;
}
/** Preserve the established variant digest without making its storage location part of identity. */
export const encodeVariantContent = ({ variant, ir }: VariantContent) =>
  JSON.stringify(variant) + "\n" + JSON.stringify(ir);
export const variantContentDigest = (content: VariantContent) =>
  createHash("sha256").update(encodeVariantContent(content)).digest("hex");
