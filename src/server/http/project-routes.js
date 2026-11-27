import { sharedWorkspaceAllowed } from "../auth/users/access.js";
import { ContentAccessError } from "../content-access/contracts.js";
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
  authorizeProjectBinding = async (_context, _projectId) => {},
  projectSessions,
  projectMembers,
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
  const visible = (context, snapshot) => projectMembers?.snapshot(context, snapshot) ?? snapshot;
  const filtered = async (context, snapshot) => access.snapshot(context, await visible(context, snapshot));
  async function authorize(context, id) {
    try {
      await authorizeProjectBinding(context, id);
    } catch (error) {
      if (errorStatus(error) === 404) throw new ProjectError(404, "projects.errorProjectNotFound");
      throw error;
    }
  }
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
    } catch (failure) {
      const error =
        failure instanceof ContentAccessError
          ? failure.code === "conflict"
            ? new ProjectError(409, "projects.errorProjectsChangedInAnotherWindowReviewTheLatestInformationAndTryAgain")
            : failure.code === "invalidInput"
              ? new ProjectError(400, "projects.errorProjectMembers")
              : failure.code === "forbidden" || failure.code === "notFound"
                ? new ProjectError(404, "projects.errorProjectNotFound")
                : failure
          : failure;
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
    respondJson(context.res, status, await filtered(context, snapshot));
  };
  return [
    {
      path: "/api/projects/workspace",
      method: "POST",
      handler: protect(async (context) => {
        const { req, res } = context;
        const body = await readJsonBody(req);
        if (typeof body.projectId !== "string") throw new ProjectError(400, "projects.errorInvalidProjectDetails");
        if (projectMembers) await authorize(context, body.projectId);
        const workspace = await workspaces.ensure(body.projectId);
        const snapshot = await catalog.snapshot();
        broadcast({ type: "project-catalog/changed", ...directoryPolicy.snapshot(snapshot) });
        respondJson(res, 200, { ...(await filtered(context, snapshot)), workspace });
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
        res.setHeader("cache-control", "private, no-store");
        if (req.method === "GET") return respondJson(res, 200, await filtered(context, await catalog.snapshot()));
        const body = await readJsonBody(req);
        if (req.method === "PATCH" && typeof body.id !== "string")
          throw new ProjectError(400, "projects.errorProjectNotFound");
        if (req.method === "POST" && body.id !== undefined)
          throw new ProjectError(400, "projects.errorInvalidProjectDetails");
        if (req.method === "PATCH" && projectMembers) {
          if (!sharedWorkspaceAllowed(req) && !(await projectMembers.isCreator(context, body.id)))
            throw new ProjectError(404, "projects.errorProjectNotFound");
          await authorize(context, body.id);
        }
        const members = req.method === "POST" ? await projectMembers?.select(body.members) : undefined;
        const snapshot =
          req.method === "POST"
            ? await workspaces.create(body, body.revision, body.operationId, projectOwner(context), members)
            : await catalog.save(body, body.revision);
        await changed(context, snapshot, req.method === "POST" ? 201 : 200);
      }),
    },
    {
      path: "/api/projects/members",
      method: ["GET", "PUT"],
      handler: protect(async (context) => {
        context.res.setHeader("cache-control", "private, no-store");
        const id = context.url.searchParams.get("project") ?? undefined;
        if (!projectMembers) {
          if (context.req.method === "GET")
            return respondJson(context.res, 200, { editable: !id, revision: null, members: [] });
          throw new ProjectError(404, "projects.errorProjectNotFound");
        }
        if (id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
          throw new ProjectError(400, "projects.errorInvalidProjectDetails");
        if (id) await catalog.project(id);
        if (context.req.method === "PUT") {
          if (!id) throw new ProjectError(400, "projects.errorInvalidProjectDetails");
          const input = await readJsonBody(context.req, 16 * 1024);
          await projectMembers.update(context, id, input.members, input.revision, input.ownerId);
          broadcast({ type: "project-catalog/changed", revision: (await catalog.snapshot()).revision });
        }
        respondJson(context.res, 200, await projectMembers.options(context, id));
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
        if (projectId !== null) {
          await catalog.project(projectId);
          try {
            await authorizeProjectBinding(context, projectId);
          } catch (error) {
            if (errorStatus(error) === 404) throw new ProjectError(404, "projects.errorProjectNotFound");
            throw error;
          }
        }
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
        const ids = sessionIds.map(harnessId).filter(Boolean);
        let snapshot;
        try {
          snapshot =
            projectId !== null && ids.length && projectSessions?.withAssignmentCheckpoints
              ? await projectSessions.withAssignmentCheckpoints(context, ids, async (managed) => {
                  await authorizeProjectBinding(context, projectId);
                  const bindings = new Map(managed.map((session) => [session.id, session]));
                  return catalog.assign(
                    projectId,
                    sessions.map((session) => bindings.get(session.id) ?? session),
                    revision,
                  );
                })
              : await catalog.assign(projectId, sessions, revision);
        } catch (error) {
          if (errorStatus(error) === 404 && !(error instanceof ProjectError))
            throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
          throw error;
        }
        await changed(context, snapshot);
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
        if (projectMembers) {
          const snapshot = await catalog.snapshot();
          const permitted = new Set((await visible(context, snapshot)).projects.map(({ id }) => id));
          const hidden = new Set(
            snapshot.assignments.filter(({ projectId }) => !permitted.has(projectId)).map(({ id }) => id),
          );
          result.sessions = result.sessions.filter(({ id }) => !hidden.has(id));
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
