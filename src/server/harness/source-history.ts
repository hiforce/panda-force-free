import { HarnessError } from "../../shared/harness/contracts.js";
import { visibleHarnessText } from "../../shared/harness/text.js";
import { isRecord } from "../../shared/records.js";
import type { SessionHistory } from "../engines/runtime-contract.js";
import type { HarnessImportedMessage, HarnessSourcePage } from "./ports.js";
/** Only visible user/assistant text crosses this legacy boundary. Older source history stays paged in its original store. */
export async function readHarnessSourcePage(
  source: SessionHistory,
  id: string,
  cwd: string,
  cursor?: string,
): Promise<HarnessSourcePage> {
  const value = await source.readConversationHistory({ threadId: id, limit: 20, ...(cursor ? { cursor } : {}) });
  if (!isRecord(value) || !isRecord(value.history) || !Array.isArray(value.history.turns))
    throw new HarnessError("unavailable", 503);
  const history: HarnessImportedMessage[] = [];
  let budget = 192 * 1024;
  for (const turn of value.history.turns.toReversed()) {
    if (!isRecord(turn) || !Array.isArray(turn.items) || turn.status === "inProgress") continue;
    const messages: HarnessImportedMessage[] = [];
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      const role = item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : null;
      if (!role) continue;
      const raw =
        typeof item.text === "string"
          ? item.text
          : Array.isArray(item.content)
            ? item.content
                .filter(isRecord)
                .filter((part) => part.type === "text")
                .map((part) => String(part.text || ""))
                .join("\n")
            : "";
      const text = visibleHarnessText(raw);
      if (!text) continue;
      const maximum = Math.min(32 * 1024, budget);
      if (maximum < 256) continue;
      const clipped = new TextDecoder().decode(Buffer.from(text).subarray(0, maximum), { stream: true });
      budget -= Buffer.byteLength(clipped);
      const time = item.createdAtMs ?? item.createdAt ?? turn.startedAtMs ?? turn.startedAt ?? turn.createdAt;
      const timestamp =
        typeof time === "number"
          ? time < 100000000000
            ? time * 1000
            : time
          : typeof time === "string"
            ? Date.parse(time)
            : NaN;
      messages.push({
        role,
        text: clipped,
        ...(typeof item.id === "string" ? { id: `source:${String(turn.id)}:${item.id}` } : {}),
        ...(typeof turn.id === "string" ? { runId: `source:${turn.id}` } : {}),
        ...(Number.isSafeInteger(timestamp) && timestamp >= 0 ? { createdAt: timestamp } : {}),
      });
    }
    history.unshift(...messages);
  }
  return {
    cwd,
    title: isRecord(value.thread) && typeof value.thread.name === "string" ? visibleHarnessText(value.thread.name) : "",
    history,
    cursor: typeof value.history.nextCursor === "string" ? value.history.nextCursor : null,
  };
}
