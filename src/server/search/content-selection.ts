import type { SearchReadScope, SearchScope, SearchSettings } from "../../shared/search/contracts.js";
import { searchContentKinds } from "../../shared/search/validation.js";

/** The same selected kinds must fence discovery, projection, hydration and repair. */
export function searchReadScope(scope: SearchScope, settings: Pick<SearchSettings, "contentKinds">): SearchReadScope {
  return {
    owner: scope.owner,
    project: scope.project,
    source: scope.source,
    contentKinds: searchContentKinds(settings.contentKinds),
  };
}
