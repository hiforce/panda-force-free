import { errorPayload } from "../http/error-payload.js";
import { ProjectError } from "./catalog.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";

export function projectRoutes({ catalog, request, getSession, recordSessions, broadcast }) {
  const candidates = new Map();
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
        console.warn("[panda-force] project API failed:", error?.code || error?.name || "unknown");
      const status = error instanceof ProjectError || error instanceof RequestBodyError ? error.status : 503;
      respondJson(ctx.res, status, {
        ...(error instanceof ProjectError ? errorPayload(error.messageId) : {}),
        error:
          error instanceof ProjectError || error instanceof RequestBodyError
            ? error.message
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
        let cursor = url.searchParams.get("cursor") || null;
        const search = (url.searchParams.get("search") || "").trim().slice(0, 200).toLocaleLowerCase();
        if (cursor && cursor.length > 4096) throw new ProjectError(400, "projects.errorInvalidSessionCursor");
        const sessions = [];
        for (let page = 0; page < (search ? 10 : 1); page++) {
          const result = await request("thread/list", {
            limit: 100,
            sortKey: "recency_at",
            sortDirection: "desc",
            useStateDbOnly: true,
            ...(cursor ? { cursor } : {}),
          });
          recordSessions(result);
          for (const s of result.data || []) {
            if (!search || [s.name, s.preview, s.id, s.cwd].join(" ").toLocaleLowerCase().includes(search)) {
              const summary = {
                id: s.id,
                name: s.name || s.preview || "",
                cwd: s.cwd || "",
                updatedAt: s.updatedAt,
                status: s.status,
              };
              sessions.push(summary);
              candidates.delete(s.id);
              candidates.set(s.id, summary);
              while (candidates.size > 10000) candidates.delete(candidates.keys().next().value);
            }
          }
          const next = result.nextCursor || null;
          if (!next || next === cursor) {
            cursor = null;
            break;
          }
          cursor = next;
          if (sessions.length >= 50) break;
        }
        respondJson(res, 200, { sessions, nextCursor: cursor });
      }),
    },
  ];
}
