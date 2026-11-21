import { createSessionDiscovery } from "../conversation/discovery.js";
import { ProjectSessionAccess } from "../projects/session-access.js";
import { validSessionReference } from "../../shared/engine/session-reference.js";
import { harnessId } from "../../shared/harness/presentation.js";
import { directoryKey, sessionMatches } from "../../shared/session-discovery.js";
import { errorCode, errorMessage, errorStatus } from "../../shared/errors.js";
import { errorPayload } from "../i18n/error-payload.js";
import { ProjectError } from "../projects/catalog.js";
import { readJsonBody, RequestBodyError } from "./body.js";
import { respondJson } from "./respond.js";

export function projectRoutes({
  catalog,
  workspaces,
  projectOwner,
  projectSessions,
  directoryPolicy,
  request: nativeRequest,
  getSession: nativeGetSession,
  recordSessions,
  broadcast,
}) {
  const getSession = async (id) => {
    const session = await nativeGetSession(id);
    if (!directoryPolicy.remember(session))
      throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
    return session;
  };
  const request = async (method, params) =>
    directoryPolicy.list(method, await nativeRequest(method, params), getSession);
  const candidates = new Map();
  const access = new ProjectSessionAccess({ policy: directoryPolicy, native: getSession, managed: projectSessions });
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
  const changed = async (context, snapshot, status = 200) => {
    broadcast({ type: "project-catalog/changed", ...directoryPolicy.snapshot(snapshot) });
    respondJson(context.res, status, await access.snapshot(context, snapshot));
  };
  return [
    {
      path: "/api/projects/workspace",
      method: "POST",
      handler: protect(async (context) => {
        const { req, res } = context;
        const body = await readJsonBody(req);
        if (typeof body.projectId !== "string") throw new ProjectError(400, "projects.errorInvalidProjectDetails");
        const workspace = await workspaces.ensure(body.projectId);
        const snapshot = await catalog.snapshot();
        broadcast({ type: "project-catalog/changed", ...directoryPolicy.snapshot(snapshot) });
        respondJson(res, 200, { ...(await access.snapshot(context, snapshot)), workspace });
      }),
    },
    {
      path: "/api/projects/directories",
      method: "GET",
      handler: protect(async (context) => {
        const cursor = queryCursor(context.url),
          assigned = new Set((await catalog.snapshot()).assignments.map((entry) => entry.id));
        const result = await discovery.directories(cursor, assigned);
        if (!cursor) {
          const directories = new Map(result.directories.map((entry) => [entry.path, { ...entry }]));
          for (const session of await access.managed(context)) {
            const path = directoryKey(session.cwd || ""),
              entry = directories.get(path) || { path, count: 0, unassignedCount: 0 };
            entry.unassignedCount ??= entry.count;
            entry.count++;
            if (!assigned.has(session.id)) entry.unassignedCount++;
            directories.set(path, entry);
          }
          result.directories = [...directories.values()];
        }
        respondJson(context.res, 200, result);
      }),
    },
    {
      path: "/api/projects",
      method: ["GET", "POST", "PATCH"],
      handler: protect(async (context) => {
        const { req, res } = context;
        if (req.method === "GET")
          return respondJson(res, 200, await access.snapshot(context, await catalog.snapshot()));
        const body = await readJsonBody(req);
        if (req.method === "PATCH" && typeof body.id !== "string")
          throw new ProjectError(400, "projects.errorProjectNotFound");
        if (req.method === "POST" && body.id !== undefined)
          throw new ProjectError(400, "projects.errorInvalidProjectDetails");
        const snapshot =
          req.method === "POST"
            ? await workspaces.create(body, body.revision, body.operationId, projectOwner(context))
            : await catalog.save(body, body.revision);
        await changed(context, snapshot, req.method === "POST" ? 201 : 200);
      }),
    },
    {
      path: "/api/projects/assign",
      method: "POST",
      handler: protect(async (context) => {
        const { req } = context;
        const { projectId, sessionIds, revision } = await readJsonBody(req);
        if (projectId !== null && typeof projectId !== "string")
          throw new ProjectError(400, "projects.errorProjectNotFound");
        if (projectId !== null) await catalog.project(projectId);
        if (
          !Array.isArray(sessionIds) ||
          !sessionIds.length ||
          sessionIds.length > 100 ||
          sessionIds.some((id) => !validSessionReference(id))
        )
          throw new ProjectError(400, "projects.errorSelectBetween1And100Sessions");
        const sessions = [];
        for (const id of sessionIds) {
          try {
            const session = harnessId(id)
              ? await access.get(context, id)
              : projectId === null && directoryPolicy.allowExternal
                ? { id }
                : candidates.get(id) || (await getSession(id));
            if (!harnessId(id) && !directoryPolicy.allowExternal && !directoryPolicy.remember(session))
              throw new Error("Session outside project root");
            sessions.push(session);
          } catch {
            throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
          }
        }
        await changed(context, await catalog.assign(projectId, sessions, revision));
      }),
    },
    {
      path: "/api/projects/history",
      method: "GET",
      handler: protect(async (context) => {
        const { res, url } = context;
        const result = await discovery.history({
          cursor: queryCursor(url),
          search: (url.searchParams.get("search") || "").slice(0, 200),
          ...(url.searchParams.has("directory") ? { directory: url.searchParams.get("directory").slice(0, 4096) } : {}),
        });
        if (!queryCursor(url)) {
          const managed = (await access.managed(context)).filter((session) =>
            sessionMatches(session, {
              search: (url.searchParams.get("search") || "").slice(0, 200).trim().toLocaleLowerCase(),
              ...(url.searchParams.has("directory")
                ? { directory: directoryKey(url.searchParams.get("directory")) }
                : {}),
            }),
          );
          result.sessions = [...managed, ...result.sessions];
        }
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
