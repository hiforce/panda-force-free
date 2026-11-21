import { stripSessionSkillContext } from "../session-skills.js";
import { stripAttachmentWorkspaceContext } from "../attachment-workspace.js";
/** Reserved application envelopes are current-input guidance, not user prose or portable historical instructions. */
export function visibleHarnessText(text: string) {
  return stripAttachmentWorkspaceContext(stripSessionSkillContext(text)).trim();
}
