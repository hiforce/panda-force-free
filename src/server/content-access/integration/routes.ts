import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { ContentAccessError } from "../contracts.js";
import { DocumentError } from "../../documents/errors.js";

export function contentAccessRoutes(
  service: {
    view(owner: string): unknown;
    grants(actor: string, project: unknown): unknown;
    set(actor: string, value: unknown): Promise<unknown>;
  },
  options: { owner(context: RouteContext): string; report(error: unknown): void },
): Route[] {
  const protect = (work: (context: RouteContext, actor: string) => Promise<void>) => async (context: RouteContext) => {
    context.res.setHeader("cache-control", "no-store");
    try {
      await work(context, options.owner(context));
    } catch (error) {
      const code =
        error instanceof ContentAccessError
          ? error.code
          : error instanceof DocumentError
            ? error.code
            : error instanceof RequestBodyError
              ? "invalidInput"
              : "unavailable";
      if (code === "unavailable") options.report(error);
      const status =
        (
          { invalidInput: 400, notFound: 404, forbidden: 403, conflict: 409, unavailable: 503 } as Record<
            string,
            number
          >
        )[code] ?? 503;
      respondJson(context.res, status, { code });
    }
  };
  return [
    {
      path: "/api/content-access",
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        if (url.search) throw new ContentAccessError("invalidInput");
        respondJson(res, 200, await service.view(actor));
      }),
    },
    {
      path: "/api/content-access/grants",
      method: ["GET", "PUT"],
      handler: protect(async ({ req, url, res }, actor) => {
        if (req.method === "GET") {
          if (url.searchParams.size !== 1 || url.searchParams.getAll("project").length !== 1)
            throw new ContentAccessError("invalidInput");
          respondJson(res, 200, await service.grants(actor, url.searchParams.get("project")));
          return;
        }
        if (
          url.search ||
          !req.headers.origin ||
          !matchesRequestOrigin({
            hostHeader: req.headers.host,
            origin: req.headers.origin,
            fetchSite: req.headers["sec-fetch-site"],
          })
        )
          throw new ContentAccessError("forbidden");
        respondJson(res, 200, await service.set(actor, await readJsonBody(req, 4096)));
      }),
    },
  ];
}
