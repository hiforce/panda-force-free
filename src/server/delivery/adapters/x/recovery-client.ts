import type { WorkflowRecord, WorkflowRecoveryReport } from "../../../../shared/delivery/workflow.js";
import type { XAccess, XJsonTransport } from "./http.js";
import { xRecoveryExpectation } from "./recovery-expectation.js";
import { invalidXInput, malformedXResponse, xData, xIdentifier } from "./response.js";
import { RemoteOperationError } from "../../workflows/errors.js";

import { X_POST_LOOKUP_FIELDS } from "./lookup-fields.js";

/** Expand only URL entities with verified offsets; never normalize arbitrary text differences. */
function expandedText(data: Record<string, unknown>, expected: string) {
  if (data.text === expected) return true;
  if (typeof data.text !== "string") return false;
  const entities = data.entities as { urls?: unknown } | undefined;
  if (!entities || !Array.isArray(entities.urls) || entities.urls.length > 100) return false;
  for (const characters of [Array.from(data.text), data.text.split("")]) {
    let cursor = 0,
      result = "",
      valid = true;
    for (const entity of entities.urls) {
      if (
        !entity ||
        typeof entity !== "object" ||
        !Number.isSafeInteger(entity.start) ||
        !Number.isSafeInteger(entity.end) ||
        entity.start < cursor ||
        entity.end <= entity.start ||
        entity.end > characters.length ||
        typeof entity.url !== "string" ||
        typeof entity.expanded_url !== "string" ||
        entity.expanded_url.length > 8192 ||
        characters.slice(entity.start, entity.end).join("") !== entity.url
      ) {
        valid = false;
        break;
      }
      result += characters.slice(cursor, entity.start).join("") + entity.expanded_url;
      cursor = entity.end;
    }
    if (valid && result + characters.slice(cursor).join("") === expected) return true;
  }
  return false;
}

/** Fixed-ID read evidence does not prove which client originally created an otherwise matching Post. */
export class XRecoveryClient {
  constructor(
    private http: XJsonTransport,
    private now = Date.now,
  ) {}
  validate(record: WorkflowRecord, stepId: number) {
    xRecoveryExpectation(record, stepId);
  }
  async inspect(
    access: XAccess,
    record: WorkflowRecord,
    stepId: number,
    remoteId: string,
  ): Promise<WorkflowRecoveryReport> {
    const expected = xRecoveryExpectation(record, stepId);
    if (!xIdentifier(remoteId) || expected.accountId !== access.accountId) throw invalidXInput();
    let data: Record<string, unknown>;
    try {
      data = xData(
        await this.http.request(`/2/tweets/${remoteId}?tweet.fields=${X_POST_LOOKUP_FIELDS}`, access, undefined, "GET"),
      );
      if (
        data.id !== remoteId ||
        !xIdentifier(data.author_id) ||
        typeof data.text !== "string" ||
        data.text.length > 100000 ||
        typeof data.created_at !== "string" ||
        !Number.isFinite(Date.parse(data.created_at))
      )
        throw malformedXResponse();
    } catch (error) {
      if (!(error instanceof RemoteOperationError)) throw error;
      // An inaccessible Post gives no evidence that the pending mutation failed.
      return { status: "unavailable", result: null, details: { remoteId, reason: error.code } };
    }
    const references = data.referenced_tweets;
    if (
      references !== undefined &&
      (!Array.isArray(references) ||
        references.some(
          (item) => !item || typeof item !== "object" || !xIdentifier(item.id) || typeof item.type !== "string",
        ))
    )
      return { status: "unavailable", result: null, details: { remoteId, reason: "invalidPlatformResponse" } };
    const reply = ((references as { id: string; type: string }[] | undefined) || []).filter(
        (item) => item.type === "replied_to",
      ),
      attachments = data.attachments as { media_keys?: unknown; poll_ids?: unknown } | undefined,
      media = attachments?.media_keys ?? [];
    const checks = {
      account: data.author_id === expected.accountId,
      text: expandedText(data, expected.text),
      reply: expected.replyTo ? reply.length === 1 && reply[0]!.id === expected.replyTo : reply.length === 0,
      composition:
        references === undefined || (references as { type: string }[]).every((item) => item.type === "replied_to"),
      media:
        (data.attachments === undefined ||
          (typeof data.attachments === "object" && data.attachments !== null && !Array.isArray(data.attachments))) &&
        Array.isArray(media) &&
        media.length === expected.mediaKeys.length &&
        media.every((key, index) => key === expected.mediaKeys[index]) &&
        attachments?.poll_ids === undefined,
      time:
        Date.parse(data.created_at as string) >= expected.attemptedAt - 120000 &&
        Date.parse(data.created_at as string) <= this.now() + 120000,
    };
    const match = Object.values(checks).every(Boolean);
    return {
      status: match ? "match" : "mismatch",
      details: { remoteId, checks, text: data.text, createdAt: data.created_at as string },
      result: match
        ? {
            postId: remoteId,
            url: `https://x.com/i/web/status/${remoteId}`,
            accountId: access.accountId,
            observedAt: this.now(),
          }
        : null,
    };
  }
}
