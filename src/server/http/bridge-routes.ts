import { gzipSync } from "node:zlib";
import { config } from "../config.js";
import type { RuntimeServices } from "./../services.js";
import { readJsonBody } from "./body.js";
import { projectRoutes } from "./project-routes.js";
import { respondError, respondJson } from "./respond.js";
import type { Route } from "./router.js";

/** Owns bridge routes. Dependencies are supplied by the composition root. */
export function bridgeRoutes({
  browserWire,
  cluster,
  watchPasswordSession,
  projectless,
  defaultCwd,
  browseRoots,
  request,
  idaasAuth,
  attachmentStorage,
  homeDir,
  reviewRoots,
  appServerConnection,
  projectVisibility,
  projectCatalog,
  sseClients,
  pendingEngineRequests,
  threadHub,
  engineDriver,
  broadcast,
  dispatchBrowserMessage,
}: Pick<
  RuntimeServices,
  | "browserWire"
  | "cluster"
  | "watchPasswordSession"
  | "projectless"
  | "defaultCwd"
  | "browseRoots"
  | "request"
  | "idaasAuth"
  | "attachmentStorage"
  | "homeDir"
  | "reviewRoots"
  | "appServerConnection"
  | "projectVisibility"
  | "projectCatalog"
  | "sseClients"
  | "pendingEngineRequests"
  | "threadHub"
  | "engineDriver"
  | "broadcast"
  | "dispatchBrowserMessage"
>): Route[] {
  return [
    {
      path: "/api/engine",
      method: "GET",
      handler: ({ res }) => respondJson(res, 200, { engine: engineDriver.descriptor }),
    },
    {
      path: "/api/approvals",
      method: "GET",
      handler: ({ res }) => respondJson(res, 200, { requests: [...pendingEngineRequests.values()] }),
    },
    ...projectRoutes({
      catalog: projectCatalog,
      request,
      getSession: (id: string) => threadHub.getThreadMetadata(id),
      recordSessions: (result: unknown) => threadHub.recordThreadPathsFromRpc(result),
      broadcast,
    }),
    {
      path: "/api/events",
      method: "GET",
      handler: async ({ req, res, idaasSession, url }) => {
        browserWire.register(res, url.searchParams.get("protocol") === "engine-v1");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        });
        res.flushHeaders?.();
        if (idaasAuth && idaasSession) {
          const unwatch = idaasAuth.watch(idaasSession.id, () => {
            if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "auth/required" })}\n\n`);
          });
          res.once("close", unwatch);
        }
        if (!idaasAuth && watchPasswordSession) {
          const unwatch = watchPasswordSession(req, () =>
            res.end(`data: ${JSON.stringify({ type: "auth/required" })}\n\n`),
          );
          res.once("close", unwatch);
        }
        res.write("retry: 1000\n\n");
        if (cluster)
          await cluster.connectEvents(
            typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : "",
            (events, resync) => {
              if (res.destroyed) return;
              for (const event of events)
                res.write(`id: ${event.fence}:${event.sequence}\ndata: ${browserWire.stringify(res, event.data)}\n\n`);
              if (resync) res.write(`data: ${JSON.stringify({ type: "bridge/resync" })}\n\n`);
              sseClients.add(res);
            },
          );
        else sseClients.add(res);
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ type: "projects/visibility", ...projectVisibility.snapshot() })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ type: "bridge/status", status: engineDriver.connected ? "connected" : "connecting" })}\n\n`,
        );
        for (const payload of pendingEngineRequests.values())
          res.write(`data: ${browserWire.stringify(res, { type: "engine/request", payload })}\n\n`);
        req.on("close", () => sseClients.delete(res));
      },
    },
    {
      path: ["/api/rpc", "/api/engine/respond", "/api/codex/respond"],
      method: "POST",
      handler: async ({ req, res, url }) => {
        try {
          const payload = await readJsonBody(req);
          const message =
            url.pathname === "/api/rpc"
              ? {
                  type: "rpc",
                  id: payload.id,
                  operationId: payload.operationId,
                  method: payload.method,
                  params: payload.params || {},
                }
              : {
                  type: payload.error ? "engine/error" : "engine/response",
                  id: payload.id,
                  requestId: payload.requestId,
                  result: payload.result,
                  error: payload.error,
                };
          const reply = await dispatchBrowserMessage(message);
          const body = Buffer.from(JSON.stringify(reply));
          const acceptsGzip = String(req.headers["accept-encoding"] || "")
            .split(",")
            .some((value) => {
              const [encoding, ...params] = value.trim().split(";");
              const quality = params.find((param) => param.trim().startsWith("q="));
              return encoding === "gzip" && (!quality || Number(quality.trim().slice(2)) > 0);
            });
          const compressed = body.length > 1024 && acceptsGzip;
          const payloadBody = compressed ? gzipSync(body) : body;
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            vary: "Accept-Encoding",
            "content-length": payloadBody.length,
            ...(compressed ? { "content-encoding": "gzip" } : {}),
          });
          res.end(payloadBody);
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
    {
      path: "/api/projects/visibility",
      method: ["GET", "POST"],
      handler: async ({ req, res }) => {
        try {
          if (req.method === "POST") {
            const { project, hidden, expectedHiddenAt } = await readJsonBody(req);
            if (typeof hidden !== "boolean") throw new Error("Invalid project visibility");
            if (projectVisibility.setHidden(project, hidden, expectedHiddenAt))
              broadcast({ type: "projects/visibility", ...projectVisibility.snapshot() });
          }
          respondJson(res, 200, projectVisibility.snapshot());
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
    {
      path: "/api/health",
      handler: ({ res }) =>
        respondJson(res, 200, {
          ok: true,
          codex: engineDriver.connected,
          engine: { id: engineDriver.descriptor.id, connected: engineDriver.connected },
          version: config.version,
          appServerMode: appServerConnection.mode,
        }),
    },
    {
      path: "/api/config",
      handler: ({ res }) =>
        respondJson(res, 200, {
          engine: engineDriver.descriptor,
          home: homeDir,
          defaultCwd,
          reviewRoot: reviewRoots[0],
          browseRoots,
          projectless,
          attachmentStorage: attachmentStorage ? "oss" : "local",
          attachmentUrlPrefix: attachmentStorage?.urlPrefix || null,
        }),
    },
  ];
}
