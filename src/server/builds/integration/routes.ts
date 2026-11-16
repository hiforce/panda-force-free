import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { DocumentError } from "../../documents/errors.js";
import { SiteProfileError } from "../../../shared/sites/config.js";
import { buildId, BuildError } from "../../../shared/builds/validation.js";
import type { SiteBuildService } from "../service.js";
import { SiteBuildError } from "../errors.js";
import { sitePreviewHeaders, type SiteBuildPreview } from "../preview.js";

export function siteBuildRoutes(
  service: SiteBuildService,
  preview: SiteBuildPreview | ((actor: string | undefined) => SiteBuildPreview),
  owner?: (context: RouteContext) => string,
): Route[] {
  const actor = (context: RouteContext) => {
    try {
      return owner?.(context);
    } catch (error) {
      // Legacy build access remains available before profile setup; native records always require an owner.
      if (error instanceof Error && "code" in error && error.code === "identityRequired") return undefined;
      throw error;
    }
  };
  const inspection = (context: RouteContext) => (typeof preview === "function" ? preview(actor(context)) : preview);
  const protect =
    (handler: Route["handler"]): Route["handler"] =>
    async (context) => {
      try {
        if (
          context.req.method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: context.req.headers.host,
            origin: context.req.headers.origin,
            fetchSite: context.req.headers["sec-fetch-site"],
          })
        )
          throw new SiteBuildError("crossOrigin", 403);
        await handler(context);
      } catch (error) {
        if (error instanceof DocumentError)
          return respondJson(context.res, error.status, errorPayload(`documents.${error.code}`));
        if (error instanceof SiteProfileError)
          return respondJson(context.res, 400, errorPayload("documents.invalidSourceConfiguration"));
        if (error instanceof SiteBuildError)
          return respondJson(context.res, error.status, errorPayload(`builds.${error.code}`));
        if (error instanceof BuildError || error instanceof RequestBodyError)
          return respondJson(context.res, 400, errorPayload("builds.invalidInput"));
        reportDiagnostic("site-builds-api", error);
        respondJson(context.res, 503, errorPayload("builds.unavailable"));
      }
    };
  const id = (url: URL) => buildId(url.searchParams.get("id") || "");
  return [
    {
      path: "/api/site-builds/pages",
      method: "GET",
      handler: protect(async (context) =>
        respondJson(context.res, 200, { pages: await inspection(context).pages(id(context.url)) }),
      ),
    },
    {
      path: "/api/site-builds/availability",
      method: "GET",
      handler: protect(async ({ res }) => respondJson(res, 200, await service.availability())),
    },
    {
      path: "/api/site-builds",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        const { req, res, url } = context;
        if (req.method === "GET")
          return respondJson(res, 200, {
            builds: await service.list(
              buildId(url.searchParams.get("space") || ""),
              url.searchParams.get("project") ?? undefined,
              actor(context),
            ),
          });
        respondJson(res, 202, { build: await service.start(await readJsonBody(req), actor(context)) });
      }),
    },
    {
      path: "/api/site-builds/detail",
      method: ["GET", "DELETE"],
      handler: protect(async (context) => {
        const { req, res, url } = context;
        if (req.method === "GET")
          return respondJson(res, 200, {
            build: await service.detail(id(url), actor(context)),
            logs: await service.logs(id(url), actor(context)),
          });
        await service.remove(id(url), actor(context));
        respondJson(res, 200, { ok: true });
      }),
    },
    {
      path: "/api/site-builds/cancel",
      method: "POST",
      handler: protect(async (context) => {
        const { req, res } = context;
        const input = await readJsonBody(req);
        respondJson(res, 200, { build: await service.cancel(buildId(String(input.id)), actor(context)) });
      }),
    },
    {
      path: "/api/site-builds/download",
      method: "GET",
      handler: protect(async (context) => {
        const { res, url } = context;
        const build = id(url),
          bytes = await service.download(build, actor(context));
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": String(bytes.length),
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename="site-${build}.zip"`,
          "x-content-type-options": "nosniff",
        });
        res.end(bytes);
      }),
    },
    {
      path: (path) => path.startsWith("/api/site-builds/preview/"),
      method: "GET",
      handler: protect(async (context) => {
        const { res, url } = context;
        const match = /^\/api\/site-builds\/preview\/([^/]+)\/(.*)$/.exec(url.pathname);
        if (!match) throw new SiteBuildError("notFound", 404);
        let path: string;
        try {
          path = decodeURIComponent(match[2]!);
        } catch {
          throw new SiteBuildError("invalidInput");
        }
        const result = await inspection(context).file(buildId(match[1]!), path);
        res.writeHead(200, sitePreviewHeaders(result.type, result.bytes.length));
        res.end(result.bytes);
      }),
    },
  ];
}
