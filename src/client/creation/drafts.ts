import type { CreationRequest, CreationSkillSelection } from "../../shared/creation/contracts.js";

export interface CreationDraft {
  prompt: string;
  profileId: string;
  runtimeId?: string;
  model?: string;
  effort?: string;
  parentId: string | null;
  selections: CreationSkillSelection[];
  pending: CreationRequest | null;
  skillsVersion?: 2;
}
/** Legacy panels inserted this scaffold without asking. Never rewrite an uncertain submission. */
export function restoreCreationDraft(draft: CreationDraft): CreationDraft {
  const value = structuredClone(draft);
  if (!value.pending && value.skillsVersion !== 2) {
    value.selections = value.selections.filter(
      (item) =>
        !(item.packageId === "panda-force.document-creation" && item.version === "1.0.0" && item.id === "writing"),
    );
    value.skillsVersion = 2;
  }
  return value;
}
/** An explicit gallery choice replaces an older version of that skill, without discarding same-version parameters. */
export function selectCreationSkill(selections: readonly CreationSkillSelection[], selected: CreationSkillSelection) {
  const next = structuredClone([...selections]);
  const index = next.findIndex((item) => item.packageId === selected.packageId && item.id === selected.id);
  if (index < 0) next.push(structuredClone(selected));
  else if (next[index]!.version !== selected.version || next[index]!.digest !== selected.digest)
    next[index] = structuredClone(selected);
  return next;
}
const memory = new Map<string, string>();
const volatileTab = crypto.randomUUID();
function tabKey() {
  try {
    let value = sessionStorage.getItem("panda-force-creation-tab");
    if (!value) {
      value = crypto.randomUUID();
      sessionStorage.setItem("panda-force-creation-tab", value);
    }
    return value;
  } catch {
    return volatileTab;
  }
}
/** Browser recovery is scoped to one authenticated identity and project; an uncertain request keeps its original ID and body. */
export class CreationDrafts {
  private key: string;
  constructor(identity: string, projectId: string) {
    this.key = "panda-force-creation:" + JSON.stringify([identity, projectId, tabKey()]);
  }
  load(): CreationDraft | null {
    try {
      let text = memory.get(this.key);
      try {
        text = localStorage.getItem(this.key) ?? text;
      } catch {
        /* Keep the current page's fallback when browser storage is unavailable. */
      }
      if (!text || text.length > 2 * 1024 * 1024) return null;
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const row = value as Partial<CreationDraft>;
      if (
        typeof row.prompt !== "string" ||
        row.prompt.length > 65536 ||
        typeof row.profileId !== "string" ||
        !(row.parentId === null || typeof row.parentId === "string") ||
        !Array.isArray(row.selections) ||
        row.selections.length > 64 ||
        (row.skillsVersion !== undefined && row.skillsVersion !== 2)
      )
        return null;
      if (
        row.selections.some(
          (item) =>
            !item ||
            typeof item.packageId !== "string" ||
            typeof item.version !== "string" ||
            typeof item.id !== "string" ||
            typeof item.digest !== "string" ||
            !item.parameters ||
            typeof item.parameters !== "object",
        )
      )
        return null;
      const pending = row.pending;
      if (
        pending !== null &&
        (!pending ||
          typeof pending.id !== "string" ||
          typeof pending.prompt !== "string" ||
          !Array.isArray(pending.selections))
      )
        return null;
      return restoreCreationDraft(row as CreationDraft);
    } catch {
      return null;
    }
  }
  save(value: CreationDraft) {
    const bytes = JSON.stringify(restoreCreationDraft(value));
    if (!memory.has(this.key) && memory.size >= 16) memory.delete(memory.keys().next().value!);
    memory.set(this.key, bytes);
    try {
      localStorage.setItem(this.key, bytes);
      return true;
    } catch {
      return false;
    }
  }
}
