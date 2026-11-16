import type { SavedSourceKind } from "./contracts.js";

/** Saved-original links select a real reader and retain the version shown in a search result or citation. */
export function savedSourceUrl(project: string, id: string, kind: SavedSourceKind = "document", version?: string) {
  if (kind === "document") return "/documents?" + new URLSearchParams({ project, document: id });
  return (
    (project === "personal" ? "/create?" : "/project?") +
    new URLSearchParams({
      ...(project === "personal" ? {} : { id: project }),
      asset: id,
      ...(version ? { assetVersion: version } : {}),
    })
  );
}
