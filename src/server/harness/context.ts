import type { HarnessHistoryEvent, HarnessMessage } from "../../shared/harness/contracts.js";
import { visibleHarnessText } from "../../shared/harness/text.js";
/** A handoff is a bounded selection with provenance, never an upload of workspace files or the raw transcript. */
export interface HarnessHandoff {
  schema: 1;
  afterSeq: number;
  throughSeq: number;
  earlierHistoryOmitted: boolean;
  clipped: boolean;
  messages: Array<{
    role: HarnessMessage["role"];
    runtime: string;
    seq: number;
    content: string;
    status: HarnessMessage["status"];
    timestamp: string | null;
    attachments: Array<{ id: string; name: string; kind: string }>;
  }>;
}
const utf8 = (value: string, bytes: number) =>
  new TextDecoder().decode(Buffer.from(value).subarray(0, Math.max(0, bytes)), { stream: true });
export function handoffContext(
  events: readonly HarnessHistoryEvent[],
  input: {
    afterSeq: number;
    exclude: readonly string[];
    earlierHistoryOmitted: boolean;
    maxBytes?: number;
    maxMessages?: number;
  },
): HarnessHandoff {
  const maxBytes = Math.min(128 * 1024, Math.max(1024, input.maxBytes ?? 32 * 1024)),
    maxMessages = Math.min(64, input.maxMessages ?? 16);
  const messages = new Map<string, HarnessMessage>();
  for (const event of events) {
    if (event.type === "message") messages.set(event.message.id, { ...event.message });
    else {
      let message = messages.get(event.messageId);
      if (!message && event.type === "text") {
        message = {
          id: event.messageId,
          seq: event.seq,
          role: "assistant",
          text: "",
          runId: "",
          runtimeId: "earlier",
          model: null,
          attachments: [],
          status: "complete",
          createdAt: 0,
        };
        messages.set(event.messageId, message);
      }
      if (message && event.type === "text") message.text += event.text;
      else if (message && event.type === "status") message.status = event.status;
    }
  }
  const eligible = [...messages.values()]
    .map((message) => ({ ...message, text: visibleHarnessText(message.text) }))
    .filter(
      (message) =>
        message.seq > input.afterSeq &&
        !input.exclude.includes(message.id) &&
        !!message.text &&
        message.role !== "tool",
    );
  const result: HarnessHandoff["messages"] = [];
  let remaining = maxBytes,
    clipped = false;
  for (const message of eligible.toReversed()) {
    if (result.length >= maxMessages || remaining <= 256) {
      clipped = true;
      break;
    }
    const view = {
      role: message.role,
      runtime: message.runtimeId,
      seq: message.seq,
      content: "",
      status: message.status,
      timestamp:
        message.sourceTimestampKnown !== false && message.createdAt > 0
          ? new Date(message.createdAt).toISOString()
          : null,
      attachments: message.attachments.map(({ id, name, kind }) => ({ id, name, kind })),
    };
    while (view.attachments.length && Buffer.byteLength(JSON.stringify(view)) > remaining / 2) {
      view.attachments.pop();
      clipped = true;
    }
    const overhead = Buffer.byteLength(JSON.stringify(view)) + 128;
    if (overhead >= remaining) {
      clipped = true;
      break;
    }
    view.content = utf8(message.text, Math.min(remaining - overhead, 8192));
    if (view.content !== message.text) clipped = true;
    result.unshift(view);
    remaining -= Buffer.byteLength(JSON.stringify(view));
  }
  return {
    schema: 1,
    afterSeq: input.afterSeq,
    throughSeq: events.at(-1)?.seq ?? input.afterSeq,
    earlierHistoryOmitted: input.earlierHistoryOmitted || eligible.length > result.length,
    clipped,
    messages: result,
  };
}
