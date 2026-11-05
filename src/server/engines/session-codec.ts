import { isRecord } from "../../shared/records.js";
import type { ContentPart, Conversation, EngineItem, EngineTurn } from "../../shared/engine/types.js";

/** Native extensions remain opaque; portable fields are validated before entering an engine session. */
function item(value: unknown): EngineItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return null;
  const result: EngineItem = { id: value.id, type: value.type, native: value };
  for (const key of ["text", "command", "aggregatedOutput", "name", "status", "tool", "server", "path", "url", "phase"])
    if (typeof value[key] === "string") Object.assign(result, { [key]: value[key] });
  if (typeof value.exitCode === "number" || value.exitCode === null) result.exitCode = value.exitCode;
  if (Array.isArray(value.content))
    result.content = value.content.flatMap((part): ContentPart[] => {
      if (!isRecord(part) || typeof part.type !== "string") return [];
      const content: ContentPart = { type: part.type };
      for (const field of ["text", "path", "url", "name", "imageUrl", "data", "mimeType"])
        if (typeof part[field] === "string") Object.assign(content, { [field]: part[field] });
      return [content];
    });
  return result;
}
function turn(value: unknown): EngineTurn | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    status: typeof value.status === "string" ? value.status : "unknown",
    items: Array.isArray(value.items)
      ? value.items.flatMap((entry) => {
          const decoded = item(entry);
          return decoded ? [decoded] : [];
        })
      : [],
  };
}
export function engineSession(value: unknown): Conversation {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) throw new Error("Invalid engine session");
  const session: Conversation = {
    id: value.id,
    turns: Array.isArray(value.turns)
      ? value.turns.flatMap((entry) => {
          const decoded = turn(entry);
          return decoded ? [decoded] : [];
        })
      : [],
  };
  for (const key of ["name", "preview", "cwd", "model", "modelProvider", "reasoningEffort", "source"])
    if (typeof value[key] === "string") Object.assign(session, { [key]: value[key] });
  for (const key of ["createdAt", "updatedAt", "recencyAt"])
    if (typeof value[key] === "string" || typeof value[key] === "number") Object.assign(session, { [key]: value[key] });
  if (isRecord(value.status) && typeof value.status.type === "string") session.status = { type: value.status.type };
  return session;
}
