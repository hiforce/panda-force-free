import { isRecord } from "../../shared/records.js";
/** @param {unknown} content */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      const value = part.text || part.input_text || part.output_text;
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function quotedProperty(source, name) {
  const match = String(source || "").match(new RegExp(`(?:^|[,\\s{])${name}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return "";
  }
}

export function commandFromToolInput(input) {
  if (!String(input || "").includes("tools.exec_command")) return "";
  return quotedProperty(input, "cmd");
}

export function contentChangeDiff(change) {
  if (!change || !["add", "delete"].includes(change.type) || typeof change.content !== "string") return "";
  const lines = change.content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) return "";
  const count = lines.length;
  const added = change.type === "add";
  const header = added ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`;
  const prefix = added ? "+" : "-";
  return `${header}\n${lines.map((line) => prefix + line).join("\n")}\n`;
}

export function outputDetails(raw) {
  const text = contentText(raw);
  const marker = text.lastIndexOf("\nOutput:\n");
  let output = marker >= 0 ? text.slice(marker + 9) : "";
  let exitCode = null;
  const lines = output.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.output === "string") output = parsed.output;
      if (Number.isInteger(parsed.exit_code)) exitCode = parsed.exit_code;
      break;
    } catch {
      /* The visible output can contain non-JSON lines. */
    }
  }
  const running = /Script running with (?:cell|session) ID/i.test(text);
  const failed = /Script (?:failed|error)/i.test(text) || (exitCode !== null && exitCode !== 0);
  return { output, exitCode, running, failed };
}

export function messageItem(payload) {
  if (payload?.type !== "message" || payload.role !== "assistant") return null;
  const text = contentText(payload.content);
  if (!text) return null;
  return {
    id: payload.id || `host-message-${Date.now()}`,
    type: "agentMessage",
    text,
    phase: payload.phase || "final_answer",
  };
}

export function reasoningItem(payload) {
  if (payload?.type !== "reasoning") return null;
  const summary = contentText(payload.summary);
  if (!summary) return null;
  return {
    id: payload.id || `host-reasoning-${Date.now()}`,
    type: "reasoning",
    summary: [summary],
    status: "completed",
  };
}
