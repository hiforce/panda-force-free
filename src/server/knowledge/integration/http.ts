import type { Route, RouteContext } from "../../http/router.js";
import { RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { KnowledgeError } from "../../../shared/knowledge/contracts.js";
import { knowledgeId } from "../../../shared/knowledge/primitives.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { DocumentError } from "../../documents/errors.js";

export function knowledgeHttp(options: { owner(context: RouteContext): string; report(error: unknown): void }) {
  const protect =
    (run: (context: RouteContext, owner: string) => Promise<void>): Route["handler"] =>
    async (context) => {
      const { req, res } = context;
      res.setHeader("cache-control", "no-store");
      if (
        req.method !== "GET" &&
        !matchesRequestOrigin({
          hostHeader: req.headers.host,
          origin: req.headers.origin,
          fetchSite: req.headers["sec-fetch-site"],
        })
      )
        return respondJson(res, 403, { code: "forbidden" });
      try {
        await run(context, options.owner(context));
      } catch (error) {
        if (error instanceof KnowledgeTaskError || error instanceof KnowledgeError || error instanceof DocumentError)
          return respondJson(res, error.status, { code: error.code });
        if (error instanceof RequestBodyError) return respondJson(res, error.status, { code: "invalidInput" });
        options.report(error);
        respondJson(res, 503, { code: "unavailable" });
      }
    };
  const query = (url: URL, name: string) => {
    if (url.searchParams.size !== 1 || url.searchParams.getAll(name).length !== 1)
      throw new KnowledgeTaskError("invalidInput");
    return knowledgeId(url.searchParams.get(name));
  };
  return { protect, query };
}
