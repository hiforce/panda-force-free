import type { Route, RouteContext } from "../http/router.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection } from "../documents/protection.js";
import { DocumentError } from "../documents/errors.js";
import { projectContentId } from "../project-content/paths.js";
import { ProjectContentError } from "../project-content/errors.js";
import { SavedSourcePageError, savedSourcePage } from "./catalog.js";
import type { FileOriginalQueries } from "./reader.js";

/** The authenticated identity selects the source authority; query parameters never select an owner or filesystem path. */
export function contentSourceRoutes(options: {
  owner(context: RouteContext): string;
  originals(owner: string, project: string): Promise<FileOriginalQueries>;
}): Route[] {
  return [
    {
      path: "/api/content-sources",
      method: "GET",
      handler: documentRouteProtection(async (context) => {
        const q = context.url.searchParams,
          keys = ["project", "contentKinds", "search", "offset", "head"];
        if (
          [...q.keys()].some((key) => !keys.includes(key)) ||
          keys.some((key) => q.getAll(key).length > 1) ||
          (q.has("offset") && !/^(?:0|[1-9][0-9]{0,4})$/.test(q.get("offset")!))
        )
          throw new DocumentError("invalidInput");
        let project: string;
        try {
          project = projectContentId(q.get("project"));
        } catch (error) {
          if (error instanceof ProjectContentError) throw new DocumentError("invalidInput");
          throw error;
        }
        const originals = await options.originals(options.owner(context), project);
        try {
          const page = await savedSourcePage(originals, project, {
            ...(q.has("contentKinds") ? { contentKinds: q.get("contentKinds")!.split(",") } : {}),
            search: q.get("search") ?? "",
            offset: Number(q.get("offset") ?? 0),
            ...(q.has("head") ? { head: q.get("head")! } : {}),
          });
          respondJson(context.res, 200, page);
        } catch (error) {
          if (error instanceof SavedSourcePageError)
            throw new DocumentError(
              error.code === "changed" ? "conflict" : "invalidInput",
              error.code === "changed" ? 409 : 400,
            );
          throw error;
        }
      }),
    },
  ];
}
