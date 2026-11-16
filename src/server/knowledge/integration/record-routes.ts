import type { Route, RouteContext } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { KnowledgeError } from "../../../shared/knowledge/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { DocumentError } from "../../documents/errors.js";
import type { KnowledgeRecords } from "../catalog/read.js";

/** Authenticated project knowledge reads never select another member's private task endpoint. */
export function knowledgeRecordRoutes(
  records: Pick<KnowledgeRecords, "detail">,
  options: { owner(context: RouteContext): string; report(error: unknown): void },
): Route[] {
  return [
    {
      path: "/api/knowledge/records/detail",
      method: "GET",
      handler: async (context) => {
        const { url, res } = context;
        res.setHeader("cache-control", "no-store");
        try {
          if (
            url.searchParams.size !== 2 ||
            url.searchParams.getAll("project").length !== 1 ||
            url.searchParams.getAll("id").length !== 1
          )
            throw new KnowledgeTaskError("invalidInput");
          const result = await records.detail(options.owner(context), {
            project: url.searchParams.get("project"),
            id: url.searchParams.get("id"),
          });
          respondJson(res, 200, result);
        } catch (error) {
          if (error instanceof KnowledgeTaskError || error instanceof KnowledgeError || error instanceof DocumentError)
            return respondJson(res, error.status, { code: error.code });
          options.report(error);
          respondJson(res, 503, { code: "unavailable" });
        }
      },
    },
  ];
}
