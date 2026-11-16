import type { TemplateSelection } from "../../../shared/presentation/templates.js";
import type { ContentIR, PublicationFormat } from "../../../shared/publishing/content.js";
import type { ContentFormatter } from "../content/formatter.js";
import { renderContent } from "../content/render.js";
import { composePosts } from "./x/posts.js";
import { contentImages } from "../content/walk.js";
import { xArticleDraft } from "./x/article-content.js";
import { richFormatLosses } from "../content/losses.js";

/** Adapter composition is the only module that enumerates platform format implementations. */
export function builtinFormats(): ReadonlyMap<PublicationFormat, ContentFormatter> {
  const entries = new Map<PublicationFormat, ContentFormatter>();
  for (const format of ["html", "plain", "wechat", "toutiao"] as const)
    entries.set(format, {
      version: "1",
      format: (ir, template) => ({
        ...renderContent(ir, template),
        posts: [],
        issues: [...ir.issues, ...richFormatLosses(ir, format)],
      }),
    });
  for (const format of ["x-post", "x-thread"] as const)
    entries.set(format, {
      version: "2",
      format(ir: ContentIR, template: TemplateSelection) {
        const posts = composePosts(ir, format === "x-thread"),
          issues = [...ir.issues, ...richFormatLosses(ir, format)];
        if (format === "x-thread" && posts.length > 1)
          issues.push({ code: "splitIntoPosts", severity: "info", blockId: "thread" });
        if (posts.some((post) => !post.valid))
          issues.push({ code: "invalidPost", severity: "blocking", blockId: "posts" });
        if (posts.some((post) => (post.imageIndexes?.length || 0) > 4))
          issues.push({ code: "postImageLimit", severity: "blocking", blockId: "posts" });
        for (const image of contentImages(ir))
          issues.push({ code: "imageNeedsUpload", severity: "warning", blockId: image.blockId });
        return { ...renderContent(ir, template), posts, issues };
      },
    });
  entries.set("x-article", {
    version: "2",
    format: (ir, template) => ({ ...renderContent(ir, template), posts: [], issues: xArticleDraft(ir).issues }),
    exportAttachments: (ir) => ({ "x-article-draft.json": { ...xArticleDraft(ir), readyToPublish: false } }),
  });
  return entries;
}
