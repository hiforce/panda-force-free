import type { Conversation, EngineTurn } from "../engine/types.js";
import type { HarnessConversationSnapshot, HarnessConversation } from "./contracts.js";
export const harnessConversationId = (id: string) => `harness:${id}`;
export function harnessId(id: unknown): string | null {
  return typeof id === "string" && /^harness:[a-f0-9-]{36}$/.test(id) ? id.slice(8) : null;
}
export function harnessSummary(conversation: Omit<HarnessConversation, "owner" | "historyBytes">): Conversation {
  return {
    id: harnessConversationId(conversation.id),
    name: conversation.title,
    cwd: conversation.cwd,
    createdAt: conversation.createdAt / 1000,
    updatedAt: conversation.updatedAt / 1000,
    status: { type: conversation.activeRunId ? "active" : "idle" },
    canAcceptDirectInput: true,
    ...(conversation.memoryPrivate ? { memoryPrivate: true } : {}),
    turns: [],
  };
}
/** Compatibility is confined to the shared browser presentation boundary, not native engine adapters. */
export function harnessPresentation(
  snapshot: HarnessConversationSnapshot,
  localizeError: (code: string) => string = (code) => code,
): Conversation {
  const turns = new Map<string, EngineTurn>();
  for (const message of snapshot.messages) {
    let turn = turns.get(message.runId);
    if (!turn) {
      turn = {
        id: message.runId,
        status: "completed",
        items: [],
        startedAt: message.createdAt / 1000,
        historyOrder: message.seq,
      };
      turns.set(message.runId, turn);
    }
    if (message.role === "user")
      turn.items.push({
        id: message.id,
        historyOrder: message.seq,
        type: "userMessage",
        clientId: message.clientId,
        content: [
          { type: "text", text: message.text },
          ...message.attachments.map((attachment) =>
            attachment.kind === "image"
              ? attachment.url
                ? { type: "image", url: attachment.url }
                : { type: "localImage", path: attachment.id }
              : {
                  type: "text",
                  text: `Attached file: ${JSON.stringify(attachment.name)}\n${attachment.url ?? attachment.id}`,
                },
          ),
        ],
      });
    else if (message.role === "assistant") {
      turn.status =
        message.status === "running"
          ? "inProgress"
          : message.status === "complete"
            ? "completed"
            : message.status === "cancelled"
              ? "interrupted"
              : "failed";
      if (message.error)
        turn.error = {
          message: localizeError(`harness.error${message.error[0]!.toUpperCase()}${message.error.slice(1)}`),
          code: message.error,
        };
      if (snapshot.run?.id === turn.id && typeof snapshot.run.thinking === "boolean")
        turn.items.push({
          id: `${turn.id}:thinking`,
          type: "reasoning",
          historyOrder: message.seq,
          status: snapshot.run.thinking && turn.status === "inProgress" ? "inProgress" : "completed",
        });
      turn.items.push({
        id: message.id,
        type: "agentMessage",
        historyOrder: message.seq,
        text: message.text,
        phase: "final_answer",
        model: message.model ?? undefined,
      });
    } else
      turn.items.push({
        id: message.id,
        type: "mcpToolCall",
        historyOrder: message.seq,
        tool: message.text,
        status: message.status === "running" ? "inProgress" : message.status === "complete" ? "completed" : "failed",
      });
  }
  for (const turn of turns.values()) {
    if (turn.status === "inProgress") continue;
    for (const item of turn.items)
      if (item.type === "mcpToolCall" && item.status === "inProgress") item.status = "interrupted";
  }
  return {
    ...harnessSummary(snapshot.conversation),
    ...(snapshot.tokenUsage ? { tokenUsage: snapshot.tokenUsage } : {}),
    threadSettings: {
      runtimeContext: `harness:${snapshot.conversation.runtimeId}`,
      model:
        (snapshot.run?.runtimeId === snapshot.conversation.runtimeId
          ? snapshot.run.model
          : snapshot.runtime?.defaultModel) ?? undefined,
      effort:
        (snapshot.run?.runtimeId === snapshot.conversation.runtimeId
          ? snapshot.run.effort
          : snapshot.runtime?.defaultEffort) ?? undefined,
    },
    modelProvider: snapshot.runtime?.name,
    model:
      (snapshot.run?.runtimeId === snapshot.conversation.runtimeId
        ? snapshot.run.model
        : snapshot.runtime?.defaultModel) ?? undefined,
    turns: [...turns.values()],
    history: {
      revision: snapshot.cursor,
      nextCursor:
        snapshot.history.nextCursor ?? (snapshot.history.hasEarlier ? String(snapshot.history.beforeBytes) : null),
      totalTurns: turns.size,
    },
  };
}
