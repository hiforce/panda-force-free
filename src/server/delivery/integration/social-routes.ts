import { isMessageId } from "../../../shared/i18n/message-id.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { ConnectionError } from "../../connections/errors.js";
import { DocumentError } from "../../documents/errors.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { Route, RouteContext } from "../../http/router.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { PublicationError } from "../../publishing/errors.js";
import { DeliveryError } from "../errors.js";
import type { SocialPublicationRouteService } from "./route-ports.js";
export function socialPublicationRoutes(
  service: SocialPublicationRouteService,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect =
    (handler: (context: RouteContext, actor: string) => Promise<void> | void): Route["handler"] =>
    async (context) => {
      try {
        const { req } = context;
        if (
          req.method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: req.headers.host,
            origin: req.headers.origin,
            fetchSite: req.headers["sec-fetch-site"],
          })
        )
          throw new DeliveryError("crossOrigin", 403);
        await handler(context, owner(context));
      } catch (error) {
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("delivery.invalidInput"));
        if (
          error instanceof DeliveryError ||
          error instanceof DocumentError ||
          error instanceof PublicationError ||
          error instanceof ConnectionError
        ) {
          const social = `social.${error.code}`,
            fallback = `${error instanceof ConnectionError ? "connections" : error instanceof PublicationError ? "publishing" : error instanceof DocumentError ? "documents" : "delivery"}.${error.code}`;
          return respondJson(
            context.res,
            error.status,
            errorPayload(isMessageId(social) ? social : isMessageId(fallback) ? fallback : "delivery.unavailable"),
          );
        }
        console.warn("[social-publication] Request could not be completed");
        respondJson(context.res, 503, errorPayload("delivery.unavailable"));
      }
    };
  const id = (url: URL, name: string) => url.searchParams.get(name) || "";
  const recoveryRoute = (action: "inspect" | "adopt"): Route => ({
    path: `/api/social-publications/recovery/${action}`,
    method: "POST",
    handler: protect(async ({ req, res }, actor) => {
      if (!service.recovery) throw new DeliveryError("unavailable", 503);
      const input = await readJsonBody(req, 4096);
      if (action === "inspect") respondJson(res, 200, { evidence: await service.recovery.inspect(actor, input) });
      else respondJson(res, 200, { publication: await service.recovery.adopt(actor, input) });
    }),
  });
  return [
    {
      path: "/api/social-publications/successor",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        if (!service.continuation) throw new DeliveryError("unavailable", 503);
        respondJson(res, 201, {
          publication: await service.continuation.prepare(actor, await readJsonBody(req, 4096)),
        });
      }),
    },
    recoveryRoute("inspect"),
    recoveryRoute("adopt"),
    {
      path: "/api/social-publications/context",
      method: "GET",
      handler: protect(async ({ res, url }, actor) =>
        respondJson(res, 200, await service.context(actor, id(url, "variant"))),
      ),
    },
    {
      path: "/api/social-publications",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }, actor) => {
        if (req.method === "GET")
          return respondJson(res, 200, {
            publications: await service.list(actor, id(url, "space"), url.searchParams.get("project") ?? undefined),
          });
        respondJson(res, 201, { publication: await service.prepare(actor, await readJsonBody(req, 4096)) });
      }),
    },
    {
      path: "/api/social-publications/detail",
      method: "GET",
      handler: protect(async ({ res, url }, actor) =>
        respondJson(res, 200, { publication: await service.detail(actor, id(url, "kind"), id(url, "id")) }),
      ),
    },
    {
      path: "/api/social-publications/article-publish",
      method: "POST",
      handler: protect(async ({ req, res }, actor) =>
        respondJson(res, 201, {
          publication: await service.prepareArticlePublish(actor, await readJsonBody(req, 4096)),
        }),
      ),
    },
    {
      path: "/api/social-publications/submit",
      method: "POST",
      handler: protect(async ({ req, res }, actor) =>
        respondJson(res, 202, { publication: await service.submit(actor, await readJsonBody(req, 4096)) }),
      ),
    },
    {
      path: "/api/social-publications/cancel",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = await readJsonBody(req, 4096);
        if (typeof input.id !== "string") throw new DeliveryError("invalidInput");
        respondJson(res, 200, { publication: await service.cancel(actor, input.kind, input.id) });
      }),
    },
  ];
}
