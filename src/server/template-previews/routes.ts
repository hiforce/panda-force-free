import { isSupportedLocale } from "../../shared/i18n/locale-policy.js";
import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { errorPayload } from "../i18n/error-payload.js";
import { templateManagementProtection } from "../templates/integration/protect.js";
import { TemplatePreviewError } from "./errors.js";
import type { TemplatePreviewService } from "./service.js";
export function templatePreviewRoutes(
  service: TemplatePreviewService,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = templateManagementProtection(owner);
  return [
    {
      path: (path) => path === "/api/template-previews" || path.startsWith("/api/template-previews/"),
      method: ["GET", "POST"],
      handler: protect(async (context, actor) => {
        const { req, res, url } = context;
        try {
          const action = url.pathname.slice("/api/template-previews".length);
          if (req.method === "GET") {
            if (action === "/image") {
              if ([...url.searchParams.keys()].sort().join(",") !== "id,view")
                throw new TemplatePreviewError("invalidInput");
              const view = url.searchParams.get("view");
              if (view !== "home" && view !== "article" && view !== "mobile")
                throw new TemplatePreviewError("invalidInput");
              const bytes = await service.image(actor, url.searchParams.get("id")!, view);
              res.writeHead(200, {
                "content-type": "image/webp",
                "content-length": bytes.length,
                "cache-control": "private, no-store",
                "x-content-type-options": "nosniff",
              });
              res.end(bytes);
              return;
            }
            if (action === "/detail" && [...url.searchParams.keys()].join(",") === "id")
              return respondJson(res, 200, { job: await service.detail(actor, url.searchParams.get("id")!) });
            if (action !== "" || [...url.searchParams.keys()].sort().join(",") !== "key,locale")
              throw new TemplatePreviewError("invalidInput");
            const locale = url.searchParams.get("locale");
            if (!isSupportedLocale(locale)) throw new TemplatePreviewError("invalidInput");
            return respondJson(res, 200, { job: await service.lookup(actor, url.searchParams.get("key")!, locale) });
          }
          if (url.search) throw new TemplatePreviewError("invalidInput");
          const body = await readJsonBody(req, 8192);
          if (action === "/retry" && Object.keys(body).join(",") === "id" && typeof body.id === "string")
            return respondJson(res, 202, { job: await service.retry(actor, body.id) });
          if (
            action !== "" ||
            Object.keys(body).sort().join(",") !== "id,locale,templateKey" ||
            typeof body.id !== "string" ||
            typeof body.templateKey !== "string" ||
            !isSupportedLocale(body.locale)
          )
            throw new TemplatePreviewError("invalidInput");
          respondJson(res, 202, { job: await service.start(actor, body.id, body.templateKey, body.locale) });
        } catch (error) {
          if (!(error instanceof TemplatePreviewError)) throw error;
          respondJson(res, error.status, { ...errorPayload(`previews.${error.code}`), code: error.code });
        }
      }),
    },
  ];
}
