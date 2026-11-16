import type { ContentIR, ContentIssue, ContentVariant } from "../../../shared/publishing/content.js";
import type { TemplateSelection } from "../../../shared/presentation/templates.js";

export interface ContentFormatter {
  version: string;
  format(
    ir: ContentIR,
    template: TemplateSelection,
  ): { text: string; html: string; posts: ContentVariant["posts"]; issues: ContentIssue[] };
  exportAttachments?(ir: ContentIR): Record<string, unknown>;
}
