import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import type { ComposerDraft } from "../contracts/repositories.js";

/** Acknowledgements remove only submitted input, preserving edits made while a request was in flight. */
export function creationDraftAfterAcknowledgement(
  draft: ComposerDraft,
  prompt: string,
  materialIds: readonly string[],
  selections: readonly CreationSkillSelection[] = [],
): ComposerDraft {
  const sent = new Set(materialIds);
  const usedSkills = new Set(selections.map(stableJson));
  return {
    ...draft,
    creationSkillsVersion: 1,
    text: draft.text.trim() === prompt.trim() ? "" : draft.text,
    mentions: draft.text.trim() === prompt.trim() ? [] : draft.mentions,
    attachments: draft.attachments.filter((attachment) => !sent.has(attachment.materialId || attachment.id)),
    skills: draft.skills?.filter((selection) => !usedSkills.has(stableJson(selection))),
  };
}
