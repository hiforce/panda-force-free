import type { CreationSkillSelection } from "./creation/contracts.js";
import { isRecord } from "./records.js";

export type { CreationSkillSummary as SessionSkillSummary } from "./creation/contracts.js";
import type { CreationSkillSummary as SessionSkillSummary } from "./creation/contracts.js";
const blocks = () => /(?:^|\n)<panda_session_skills>\n([\s\S]*?)\n<\/panda_session_skills>(?:\n|$)/g;

/** Reserved guidance is excluded from message text, copies and delivery matching. */
export function stripSessionSkillContext(text: string) {
  return String(text || "").replace(blocks(), "");
}
export function stripSessionSkillPreview(text: string) {
  return stripSessionSkillContext(text).replace(/(?:^|\n)<panda_session_skills>(?:\n|$)[\s\S]*$/, "");
}
export function sessionSkillContext(summary: readonly SessionSkillSummary[], guidance: string) {
  // JSON encoding prevents package text from terminating the reserved envelope.
  const payload = JSON.stringify({ schema: 1, summary, guidance }).replace(/</g, "\\u003c");
  return `<panda_session_skills>\n${payload}\n</panda_session_skills>`;
}
export function sessionSkillsFromInput(input: readonly { type: string; text?: string }[] = []): SessionSkillSummary[] {
  for (const part of input) {
    if (part.type !== "text" || !part.text || part.text.length > 400000) continue;
    for (const match of part.text.matchAll(blocks())) {
      try {
        const value: unknown = JSON.parse(match[1]!);
        if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.summary) || value.summary.length > 64)
          continue;
        const result: SessionSkillSummary[] = [];
        for (const item of value.summary) {
          if (!isRecord(item) || !isRecord(item.selection) || !isRecord(item.name)) continue;
          const ref = item.selection;
          if (
            ![ref.packageId, ref.version, ref.id].every(
              (v) => typeof v === "string" && v.length > 0 && v.length < 256,
            ) ||
            typeof ref.digest !== "string" ||
            !/^[a-f0-9]{64}$/.test(ref.digest) ||
            !isRecord(ref.parameters) ||
            !Object.values(ref.parameters).every(
              (v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)),
            ) ||
            !Object.values(item.name).every((v) => typeof v === "string")
          )
            continue;
          result.push({
            selection: ref as unknown as CreationSkillSelection,
            name: item.name as Record<string, string>,
          });
        }
        return result;
      } catch {
        /* Truncated or older history must remain readable. */
      }
    }
  }
  return [];
}
