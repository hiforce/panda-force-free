import type { ComposerDraft } from "../contracts/repositories.js";

/** Acknowledgements remove only submitted input, preserving edits made while a request was in flight. */
export function creationDraftAfterAcknowledgement(
  draft: ComposerDraft,
  prompt: string,
  materialIds: readonly string[],
): ComposerDraft {
  const sent = new Set(materialIds);
  return {
    ...draft,
    text: draft.text.trim() === prompt.trim() ? "" : draft.text,
    mentions: draft.text.trim() === prompt.trim() ? [] : draft.mentions,
    attachments: draft.attachments.filter((attachment) => !sent.has(attachment.materialId || attachment.id)),
  };
}
