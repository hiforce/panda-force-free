import { matchesRequestOrigin } from "../auth/origin.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import { errorPayload } from "../i18n/error-payload.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { InvalidNotificationRequest, type NotificationCenter } from "./center.js";

export function notificationRoutes(center: NotificationCenter, owner: (context: RouteContext) => string): Route[] {
  const handle =
    (work: (context: RouteContext, actor: string) => Promise<void>): Route["handler"] =>
    async (context) => {
      const { req, res } = context;
      let actor: string;
      try {
        if (
          req.method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: req.headers.host,
            origin: req.headers.origin,
            fetchSite: req.headers["sec-fetch-site"],
          })
        )
          throw new Error("Invalid origin");
        actor = owner(context);
      } catch {
        return respondJson(res, 403, errorPayload("notifications.identityRequired"));
      }
      try {
        await work(context, actor);
      } catch (error) {
        if (error instanceof InvalidNotificationRequest || error instanceof RequestBodyError)
          return respondJson(
            res,
            error instanceof RequestBodyError ? error.status : 400,
            errorPayload("notifications.invalidRequest"),
          );
        reportDiagnostic("notifications", error);
        respondJson(res, 503, errorPayload("notifications.loadFailed"));
      }
    };
  return [
    {
      method: "GET",
      path: "/api/notifications",
      handler: handle(async ({ url, res }, actor) => {
        const params = url.searchParams;
        if ([...params.keys()].some((key) => !["view", "cursor"].includes(key) || params.getAll(key).length !== 1))
          throw new InvalidNotificationRequest();
        const view = params.get("view"),
          cursor = params.get("cursor");
        if (view === "history") return respondJson(res, 200, await center.history(actor, cursor));
        if (view !== "preview" || cursor !== null) throw new InvalidNotificationRequest();
        respondJson(res, 200, await center.preview(actor));
      }),
    },
    {
      method: "POST",
      path: "/api/notifications/read",
      handler: handle(async ({ req, res, url }, actor) => {
        const input = await readJsonBody(req, 2048);
        if (
          url.search ||
          !input ||
          typeof input !== "object" ||
          !("source" in input) ||
          !("id" in input) ||
          typeof input.source !== "string" ||
          typeof input.id !== "string" ||
          Object.keys(input).length !== 2
        )
          throw new InvalidNotificationRequest();
        const read = await center.read(actor, input.source, input.id);
        if (!read) return respondJson(res, 404, errorPayload("notifications.notFound"));
        respondJson(res, 200, { read: true });
      }),
    },
  ];
}
