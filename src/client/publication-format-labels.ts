import type { PublicationFormat } from "../shared/publishing/content.js";
import type { MessageId } from "../shared/i18n/messages.js";

export const publicationFormatLabels: Record<PublicationFormat, MessageId> = {
  html: "publishing.formatHtml",
  plain: "publishing.formatPlain",
  "x-post": "publishing.formatXPost",
  "x-thread": "publishing.formatXThread",
  "x-article": "publishing.formatXArticle",
  wechat: "publishing.formatWechat",
  toutiao: "publishing.formatToutiao",
};
