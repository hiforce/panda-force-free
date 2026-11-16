import type { Translate } from "../../../shared/i18n/messages.js";
export function codeBlockPhrases(t: Translate): Record<string, string> {
  return { "Fold line": t("codeBlocks.fold"), "Unfold line": t("codeBlocks.unfold"), unfold: t("codeBlocks.unfold") };
}
