import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { HarnessError, type HarnessCapabilities } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { HarnessAgentEvent, HarnessPrompt } from "../ports.js";

export const acpRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
export const acpText = (value: unknown) => (typeof value === "string" ? value : "");
export type AcpEmit = (event: HarnessAgentEvent) => Promise<void>;

/** Keep protocol permission IDs and engine activity out of portable conversation history. */
export class AcpTurnEvents {
  private readonly permissions = new Map<string, { options: Set<string>; resolve(value: unknown): void }>();

  async update(update: Record<string, unknown>, emit: AcpEmit) {
    const kind = update.sessionUpdate;
    if (kind === "agent_thought_chunk") await emit({ type: "activity" });
    else if (kind === "agent_message_chunk" && acpRecord(update.content).type === "text")
      await emit({ type: "text", text: acpText(acpRecord(update.content).text) });
    else if (kind === "tool_call" || kind === "tool_call_update") {
      const status = update.status === "completed" ? "complete" : update.status === "failed" ? "error" : "running";
      await emit({
        type: "tool",
        id: acpText(update.toolCallId),
        name: acpText(update.title) || acpText(update.kind) || "tool",
        status,
      });
    }
  }

  async request(method: string, params: Record<string, unknown>, sessionId: string | undefined, emit: AcpEmit | null) {
    if (method !== "session/request_permission") throw new HarnessError("capabilityUnavailable");
    if (!emit || this.permissions.size >= 16 || params.sessionId !== sessionId)
      return { outcome: { outcome: "cancelled" } };
    const options = (Array.isArray(params.options) ? params.options : [])
      .map(acpRecord)
      .filter((value) => typeof value.optionId === "string" && value.optionId)
      .map((value) => ({ id: acpText(value.optionId), name: acpText(value.name), kind: acpText(value.kind) }));
    if (!options.length) return { outcome: { outcome: "cancelled" } };
    const id = randomUUID();
    const response = new Promise<unknown>((resolve) =>
      this.permissions.set(id, { resolve, options: new Set(options.map((option) => option.id)) }),
    );
    try {
      await emit({ type: "permission", id, title: acpText(acpRecord(params.toolCall).title) || "tool", options });
    } catch (error) {
      if (this.permissions.has(id)) this.respond(id, null);
      throw error;
    }
    return response;
  }

  respond(id: string, optionId: string | null) {
    const pending = this.permissions.get(id);
    if (!pending) throw new HarnessError("notFound", 404);
    if (optionId !== null && !pending.options.has(optionId)) throw new HarnessError("invalidInput");
    this.permissions.delete(id);
    pending.resolve({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
  }

  cancelPermissions() {
    for (const id of this.permissions.keys()) this.respond(id, null);
  }
}

export async function acpPrompt(input: HarnessPrompt, capabilities: HarnessCapabilities) {
  const prompt: Array<Record<string, unknown>> = [{ type: "text", text: input.text }];
  for (const attachment of input.attachments) {
    if (attachment.kind === "image" && capabilities.imageInput) {
      if (attachment.bytes > 2 * 1024 * 1024) throw new HarnessError("invalidInput", 413);
      const data = await readFile(attachment.path);
      prompt.push({ type: "image", mimeType: attachment.mimeType, data: data.toString("base64") });
    } else if (capabilities.fileInput) {
      prompt.push({
        type: "resource_link",
        uri: pathToFileURL(attachment.path).href,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
    } else throw new HarnessError("capabilityUnavailable", 409);
  }
  return prompt;
}
