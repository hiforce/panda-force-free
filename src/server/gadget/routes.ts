import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { matchesRequestOrigin } from "../auth/origin.js";
import { GadgetError, gadgetFailure } from "../../shared/gadget/contracts.js";
import { isRecord } from "../../shared/records.js";
import type { GadgetWorkspaceService } from "./service.js";
export function gadgetRoutes(service: GadgetWorkspaceService, owner: (ctx: RouteContext) => string): Route[] {
  return [
    {
      path: (p) => p === "/api/gadgets" || p.startsWith("/api/gadgets/"),
      method: ["GET", "POST", "PUT"],
      handler: async (context) => {
        const { req, res, url } = context;
        res.setHeader("Cache-Control", "private, no-store");
        const abort = new AbortController();
        const stopped = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.on("close", stopped);
        try {
          const actor = owner(context);
          if (!actor) throw new GadgetError("forbidden", 403);
          if (
            req.method !== "GET" &&
            !matchesRequestOrigin({
              hostHeader: req.headers.host,
              origin: req.headers.origin,
              fetchSite: req.headers["sec-fetch-site"],
            })
          )
            throw new GadgetError("forbidden", 403);
          if (url.search) throw new GadgetError("invalidInput");
          if (url.pathname === "/api/gadgets/catalog" && req.method === "GET") {
            respondJson(res, 200, { apiVersion: 1, gadgets: service.registry.catalog() });
            return;
          }
          if (url.pathname === "/api/gadgets/layout" && req.method === "GET") {
            const layout = await service.layout(actor);
            res.setHeader("ETag", `"${layout.revision}"`);
            respondJson(res, 200, layout);
            return;
          }
          if (url.pathname === "/api/gadgets/layout" && req.method === "PUT") {
            const layout = await service.save(
              actor,
              await readJsonBody(req, 128 * 1024),
              typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined,
            );
            res.setHeader("ETag", `"${layout.revision}"`);
            respondJson(res, 200, layout);
            return;
          }
          if (["/api/gadgets/data", "/api/gadgets/actions"].includes(url.pathname) && req.method === "POST") {
            const body = await readJsonBody(req, 16000);
            if (
              !isRecord(body) ||
              typeof body.gadget !== "string" ||
              typeof body.name !== "string" ||
              typeof body.instanceId !== "string" ||
              body.instanceId.length > 120
            )
              throw new GadgetError("invalidInput");
            const value = await service.registry.invoke(
              url.pathname.endsWith("data") ? "services" : "actions",
              body.gadget,
              body.name,
              {
                owner: actor,
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
                instanceId: body.instanceId,
              },
              body.config ?? {},
              body.input ?? null,
            );
            respondJson(res, 200, { value });
            return;
          }
          const asset = /^\/api\/gadgets\/frontend\/([a-z0-9.-]+)$/.exec(url.pathname);
          if (asset && req.method === "GET") {
            const module = service.registry.get(asset[1]!);
            if (!module?.frontend) throw new GadgetError("missing", 404);
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.writeHead(200);
            res.end(module.frontend);
            return;
          }
          throw new GadgetError("missing", 404);
        } catch (error) {
          const failure = gadgetFailure(error);
          if (failure?.status === 503) res.setHeader("Retry-After", "1");
          const code = failure?.code ?? (error instanceof RequestBodyError ? "invalidInput" : "unavailable");
          respondJson(res, failure?.status ?? (error instanceof RequestBodyError ? error.status : 503), {
            error: { code, messageId: `gadget.${code}` },
          });
        } finally {
          res.off("close", stopped);
        }
      },
    },
  ];
}
