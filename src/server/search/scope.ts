import { createHash } from "node:crypto";
import type { SearchScope } from "../../shared/search/contracts.js";

/** Personal content is principal-owned; project projections share identity while requests retain their authenticated actor. */
export const searchScopeKey = (scope: SearchScope) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        scope.project === "personal"
          ? [scope.source, scope.owner, scope.project]
          : ["project-search-v1", scope.source, scope.project],
      ),
    )
    .digest("hex");
