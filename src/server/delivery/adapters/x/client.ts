import twitterText from "twitter-text";
import type { XArticleDraft } from "../../../../shared/publishing/x-article.js";
import type { XAccess, XJsonTransport } from "./http.js";
import {
  xIdentifier as identifier,
  invalidXInput as invalid,
  malformedXResponse as malformed,
  xData as data,
} from "./response.js";
/** Platform DTO validation and receipts are separate from durable orchestration and OAuth lifecycle. */
export class XPublicationClient {
  constructor(
    private http: XJsonTransport,
    private now = Date.now,
  ) {}
  async post(access: XAccess, input: { text: string; replyTo?: string; mediaIds?: string[]; madeWithAi?: boolean }) {
    if (
      !twitterText.parseTweet(input.text).valid ||
      (input.replyTo !== undefined && !identifier(input.replyTo)) ||
      (input.mediaIds !== undefined &&
        (!input.mediaIds.length || input.mediaIds.length > 4 || !input.mediaIds.every(identifier)))
    )
      throw invalid();
    const result = data(
      await this.http.request(
        "/2/tweets",
        access,
        JSON.stringify({
          text: input.text,
          ...(input.replyTo ? { reply: { in_reply_to_tweet_id: input.replyTo } } : {}),
          ...(input.mediaIds ? { media: { media_ids: input.mediaIds } } : {}),
          ...(input.madeWithAi === undefined ? {} : { made_with_ai: input.madeWithAi }),
        }),
      ),
    );
    if (!identifier(result.id) || typeof result.text !== "string" || result.text.length > 100000) throw malformed();
    return {
      postId: result.id,
      url: `https://x.com/i/web/status/${result.id}`,
      accountId: access.accountId,
      receivedAt: this.now(),
    };
  }
  async draft(access: XAccess, payload: XArticleDraft) {
    if (!payload.title.trim() || !payload.content_state.blocks.length) throw invalid();
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 1024 * 1024) throw invalid();
    const result = data(await this.http.request("/2/articles/draft", access, body));
    if (!identifier(result.id) || typeof result.title !== "string" || result.title !== payload.title) throw malformed();
    return { articleId: result.id, accountId: access.accountId, receivedAt: this.now() };
  }
  async publishArticle(access: XAccess, articleId: string) {
    if (!identifier(articleId)) throw invalid();
    const result = data(await this.http.request(`/2/articles/${articleId}/publish`, access));
    if (!identifier(result.post_id)) throw malformed();
    return {
      articleId,
      postId: result.post_id,
      url: `https://x.com/i/web/status/${result.post_id}`,
      accountId: access.accountId,
      receivedAt: this.now(),
    };
  }
}
