import { mkdir } from "node:fs/promises";
import { isRecord } from "../../../shared/records.js";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";
import { applicationRunFailure } from "../../../shared/engine/application-failure.js";
import type { BotChatFailure, BotChatMessage } from "../../../shared/bots/workspace.js";
import type { BotConfig } from "../../../shared/bots/contracts.js";
import type { BotRepository } from "../repository.js";
import { botPersonaInstructions } from "../persona.js";
import type { BotWorkspaceRecord } from "./storage.js";
import { chatPrefix, type BotChatState } from "./chat-records.js";
import { BotChatLease } from "./chat-lease.js";

/** Human conversation has its own reply tool and engine session; task decision tools are never included. */
export async function executeBotChat(
  store: BotRepository,
  row: BotWorkspaceRecord<BotChatState>,
  controller: AbortController,
  engine: (bot: BotConfig) => ApplicationToolEngine,
  directory: (botId: string) => string,
) {
  const pending = row.data.pending!,
    bot = { ...(await store.bot(row.owner, row.botId)), ...pending.bot },
    lease = new BotChatLease(store.workspace, row.owner, row.botId, row.data.generation, pending.lease!),
    heartbeat = setInterval(() => {
      void lease
        .touch()
        .then((valid) => {
          if (!valid) controller.abort();
        })
        .catch(() => controller.abort());
    }, 1000);
  let reply = "",
    scope: { sessionId: string; runId: string } | null = null,
    flushedAt = 0;
  const fail = async (failure: BotChatFailure) => lease.finish("", failure);
  try {
    await mkdir(directory(bot.id), { recursive: true, mode: 0o700 });
    const user = await store.workspace.get<BotChatMessage>(row.owner, { kind: "chat-message", id: pending.userId });
    if (!user) throw new Error("Bot input missing");
    let prompt = user.data.text;
    if (!row.data.sessionId) {
      const history = (
        await store.workspace.list<BotChatMessage>(row.owner, "chat-message", {
          botId: bot.id,
          prefix: chatPrefix(bot.id, row.data.generation),
          descending: true,
          limit: 80,
        })
      )
        .map((item) => item.data)
        .filter((m) => m.status === "complete")
        .reverse();
      const bounded: Array<{ role: string; text: string }> = [];
      let bytes = 0;
      for (const message of history.reverse()) {
        bytes += Buffer.byteLength(message.text);
        if (bytes > 180000) break;
        bounded.unshift({ role: message.role, text: message.text });
      }
      prompt = JSON.stringify({ conversation: bounded });
    }
    const result = await engine(bot).run(
      {
        persistent: true,
        ...(row.data.sessionId ? { sessionId: row.data.sessionId } : {}),
        prompt,
        instructions: `You are ${bot.name}, speaking directly with your human user in your one continuing conversation. Reply naturally in the user's language. A supplied conversation array is ordered context: answer its last user message. You are separate from automated Bot tasks; never assume access to their data or to external connections. Ask clarifying questions conversationally when needed. Deliver exactly one complete final reply using panda_bot_chat_reply. The tool publishes your reply into this human conversation only. Do not claim to have sent emails, posted messages, changed external data or completed queued tasks. You have no task decision or external action tool in this conversation. Bot working rules:\n${bot.instructions}${botPersonaInstructions(bot)}`,
        tools: [
          {
            name: "panda_bot_chat_reply",
            description: "Deliver the complete final reply to the human in this conversation.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", minLength: 1, maxLength: 64000 } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        signal: controller.signal,
        session: (sessionId) => lease.bind(sessionId, bot.model),
        started: async (value) => {
          await lease.bind(value.sessionId, bot.model, value.runId);
          scope = value;
        },
        event: async (event) => {
          if (event.kind !== "message" || Date.now() - flushedAt < 500) return;
          flushedAt = Date.now();
          await lease.message(event.text);
        },
        call: async (call) => {
          if (
            controller.signal.aborted ||
            !(await lease.current()) ||
            !scope ||
            call.sessionId !== scope.sessionId ||
            call.runId !== scope.runId ||
            call.name !== "panda_bot_chat_reply" ||
            reply ||
            !isRecord(call.arguments) ||
            Object.keys(call.arguments).length !== 1 ||
            typeof call.arguments.text !== "string" ||
            !call.arguments.text.trim() ||
            call.arguments.text.length > 64000
          )
            throw new Error("Invalid Bot conversation reply");
          reply = call.arguments.text.trim();
          return { success: true, text: "Reply accepted for this human conversation." };
        },
      },
    );
    if (result.status === "completed" && reply) await lease.finish(reply);
    else await fail(result.status === "interrupted" ? "interrupted" : (result.failure ?? "failed"));
  } catch (error) {
    await fail(controller.signal.aborted ? "interrupted" : applicationRunFailure(error));
  } finally {
    clearInterval(heartbeat);
  }
}
