import type { XArticleDraft } from "../publishing/x-article.js";
import type { WorkflowRecord } from "./workflow.js";
import type { PublicationImage } from "./media.js";
import type { ContentSourceScope } from "../publishing/source-scope.js";

export interface SocialSource extends ContentSourceScope {
  documentId: string;
  revisionId: string;
  sourceHash: string;
  variantId: string;
  variantDigest: string;
  templateId: string;
  templateVersion: string;
  formatterVersion: string;
}
export type SocialContent =
  | { format: "x-post" | "x-thread"; posts: string[]; postMedia?: string[][] }
  | { format: "x-article"; draft: XArticleDraft };
export interface SocialTarget {
  id: string;
  projectId: string;
  version: number;
  accountId: string;
  username: string;
}
export interface SocialPayload {
  adapterVersion: 1 | 2;
  source: SocialSource;
  target: SocialTarget;
  content: SocialContent;
  media?: PublicationImage[];
  /** API access, Article eligibility and charges are not proven by an OAuth grant. */
  platformCosts: "unknown";
}
export interface ArticlePublishPayload {
  adapterVersion: 1 | 2;
  source: SocialSource;
  target: SocialTarget;
  draftJobId: string;
  articleId: string;
  draft: XArticleDraft;
  media?: PublicationImage[];
  platformCosts: "unknown";
}
export type SocialWorkflowKind = "x-post" | "x-article-draft" | "x-article-publish";
export type SocialPublication = WorkflowRecord;
