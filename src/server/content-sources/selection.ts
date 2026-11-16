import { SAVED_SOURCE_LIMITS as limits, type SavedSourceKind } from "../../shared/content-sources/contracts.js";
import { ProjectContentError } from "../project-content/errors.js";
import { projectContentId } from "../project-content/paths.js";

/** Copy selection intent before asynchronous authorization, including empty repository reads. */
export function savedSourceSelection(kinds: readonly SavedSourceKind[], requested?: ReadonlySet<string>) {
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    kinds.length > 3 ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((kind) => !["document", "web", "slides"].includes(kind))
  )
    throw new ProjectContentError("invalidFile");
  if (requested && (!Number.isSafeInteger(requested.size) || requested.size < 0 || requested.size > limits.selected))
    throw new ProjectContentError("tooLarge");
  return { kinds: [...kinds], ids: requested ? new Set([...requested].map(projectContentId)) : undefined };
}
