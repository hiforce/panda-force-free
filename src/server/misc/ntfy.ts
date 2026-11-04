import { config } from "../config.js";

/** Push a turn-completed notification to the configured ntfy topic, if any. */
export async function notifyNtfyTurnCompleted(params: any) {
  if (!config.ntfyTopic) return;
  const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const body = `PandaForce task completed${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`;
  try {
    await fetch(`${config.ntfyUrl}/${encodeURIComponent(config.ntfyTopic)}`, {
      method: "POST",
      headers: { Title: "PandaForce task completed", Tags: "white_check_mark", ...(turnId ? { "X-Turn-Id": turnId } : {}) },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("ntfy notification failed:", error instanceof Error ? error.message : error);
  }
}
