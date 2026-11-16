import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection as protect } from "./protection.js";
import { text } from "./validation.js";
import type { ProjectDocumentEditor, ProjectDocumentQueries } from "./editor-port.js";

/** The authenticated composition supplies actor identity. Requests cannot select authors or cross-project lookup roots. */
export function projectDocumentEditorRoutes(
  queries: ProjectDocumentQueries,
  editor: ProjectDocumentEditor,
  principal: (context: RouteContext) => string,
): Route[] {
  const scope = (url: URL) =>
    [text(url.searchParams.get("project"), 128), text(url.searchParams.get("id"), 128)] as const;
  return [
    {
      path: "/api/project-documents/editor",
      method: ["GET", "PUT", "DELETE"],
      handler: protect(async (context) => {
        const { req, res, url } = context,
          [projectId, documentId] = scope(url);
        if (req.method === "GET") return respondJson(res, 200, await queries.editor(projectId, documentId));
        const actor = principal(context),
          input = await readJsonBody(req, req.method === "PUT" ? 6 * 1024 * 1024 : 8192),
          receipt =
            req.method === "PUT"
              ? await editor.autosave(actor, projectId, documentId, input)
              : await editor.discard(actor, projectId, documentId, input);
        respondJson(res, 200, { receipt });
      }),
    },
    ...(["save", "restore"] as const).map((action): Route => ({
      path: "/api/project-documents/checkpoints" + (action === "restore" ? "/restore" : ""),
      method: "POST",
      handler: protect(async (context) => {
        const [projectId, documentId] = scope(context.url),
          actor = principal(context),
          input = await readJsonBody(context.req, 8192);
        respondJson(context.res, 200, await editor[action](actor, projectId, documentId, input));
      }),
    })),
    {
      path: "/api/project-documents/source",
      method: "GET",
      handler: protect(async ({ res, url }) => respondJson(res, 200, await queries.detail(...scope(url)))),
    },
    {
      path: "/api/project-documents/revisions",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const [projectId, documentId] = scope(url);
        respondJson(
          res,
          200,
          url.searchParams.has("revision")
            ? { revision: await queries.revision(projectId, documentId, text(url.searchParams.get("revision"), 128)) }
            : { revisions: await queries.revisions(projectId, documentId) },
        );
      }),
    },
    {
      path: "/api/project-documents/catalog",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(
          res,
          200,
          await queries.list(
            text(url.searchParams.get("project"), 128),
            text(url.searchParams.get("space"), 128),
            url.searchParams.get("search") ?? "",
            Number(url.searchParams.get("offset") ?? 0),
          ),
        ),
      ),
    },
  ];
}
