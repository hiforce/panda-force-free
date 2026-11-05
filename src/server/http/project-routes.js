import { createSessionDiscovery } from "../conversation/discovery.js";
import { errorCode, errorMessage, errorStatus } from "../../shared/errors.js";
import { errorPayload } from "../i18n/error-payload.js";
import { ProjectError } from "../projects/catalog.js";
import { readJsonBody, RequestBodyError } from "./body.js";
import { respondJson } from "./respond.js";

export function projectRoutes({ catalog, request, getSession, recordSessions, broadcast }) {
  const candidates = new Map();
  const discovery = createSessionDiscovery({ request, recordSessions });
  function queryCursor(url) {
    const cursor = url.searchParams.get("cursor") || null;
    if (cursor && cursor.length > 4096) throw new ProjectError(400, "projects.errorInvalidSessionCursor");
    return cursor;
  }
  const protect = (handler) => async (ctx) => {
    try {
      if (ctx.req.method !== "GET") {
        const origin = ctx.req.headers.origin;
        if (
          ctx.req.headers["sec-fetch-site"] === "cross-site" ||
          (origin && new URL(origin).host !== ctx.req.headers.host)
        )
          throw new ProjectError(403, "projects.errorCrossOriginRequestRejected");
      }
      await handler(ctx);
    } catch (error) {
      // Record operational failures without logging submitted project data.
      if (!(error instanceof ProjectError) && !(error instanceof RequestBodyError))
        console.warn(
          "[panda-force] project API failed:",
          errorCode(error) || (error instanceof Error ? error.name : "unknown"),
        );
      const status = error instanceof ProjectError || error instanceof RequestBodyError ? errorStatus(error) : 503;
      respondJson(ctx.res, status, {
        ...(error instanceof ProjectError ? errorPayload(error.messageId) : {}),
        error:
          error instanceof ProjectError || error instanceof RequestBodyError
            ? errorMessage(error)
            : "Project information is temporarily unavailable. Please retry.",
      });
    }
  };
  const changed = (res, snapshot, status = 200) => {
    broadcast({ type: "project-catalog/changed", ...snapshot });
    respondJson(res, status, snapshot);
  };
  return [
    {
      path: "/api/projects/directories",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(
          res,
          200,
          await discovery.directories(
            queryCursor(url),
            new Set(catalog.snapshot().assignments.map((entry) => entry.id)),
          ),
        ),
      ),
    },
    {
      path: "/api/projects",
      method: ["GET", "POST", "PATCH"],
      handler: protect(async ({ req, res }) => {
        if (req.method === "GET") return respondJson(res, 200, catalog.snapshot());
        const body = await readJsonBody(req);
        if (req.method === "PATCH" && typeof body.id !== "string")
          throw new ProjectError(400, "projects.errorProjectNotFound");
        if (req.method === "POST" && body.id !== undefined)
          throw new ProjectError(400, "projects.errorInvalidProjectDetails");
        changed(res, catalog.save(body, body.revision), req.method === "POST" ? 201 : 200);
      }),
    },
    {
      path: "/api/projects/assign",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const { projectId, sessionIds, revision } = await readJsonBody(req);
        if (projectId !== null && typeof projectId !== "string")
          throw new ProjectError(400, "projects.errorProjectNotFound");
        if (projectId !== null) catalog.project(projectId);
        if (
          !Array.isArray(sessionIds) ||
          !sessionIds.length ||
          sessionIds.length > 100 ||
          sessionIds.some((id) => typeof id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(id))
        )
          throw new ProjectError(400, "projects.errorSelectBetween1And100Sessions");
        const sessions = [];
        for (const id of sessionIds) {
          try {
            sessions.push(projectId === null ? { id } : candidates.get(id) || (await getSession(id)));
          } catch {
            throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
          }
        }
        changed(res, catalog.assign(projectId, sessions, revision));
      }),
    },
    {
      path: "/api/projects/history",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const result = await discovery.history({
          cursor: queryCursor(url),
          search: (url.searchParams.get("search") || "").slice(0, 200),
          ...(url.searchParams.has("directory") ? { directory: url.searchParams.get("directory").slice(0, 4096) } : {}),
        });
        for (const session of result.sessions) {
          candidates.delete(session.id);
          candidates.set(session.id, session);
          while (candidates.size > 10000) candidates.delete(candidates.keys().next().value);
        }
        respondJson(res, 200, result);
      }),
    },
  ];
}
