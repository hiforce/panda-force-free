import type { Route } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { documentRouteProtection as protect } from "./protection.js";
import type { MySQLProjectDocumentLibrary } from "./mysql-library-service.js";
import { text } from "./validation.js";
export function mysqlProjectLibraryRoutes(library: MySQLProjectDocumentLibrary): Route[] {
  const project = (url: URL) => text(url.searchParams.get("project"), 128);
  return [
    {
      path: "/api/project-documents",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }) => {
        if (req.method === "GET") return respondJson(res, 200, await library.overview(project(url)));
        const input = await readJsonBody(req, 8192);
        respondJson(res, 201, await library.create(text(input.projectId, 128), input));
      }),
    },
    {
      path: "/api/project-documents/folders",
      method: ["POST", "PUT", "DELETE"],
      handler: protect(async ({ req, res }) => {
        const input = await readJsonBody(req, 8192),
          projectId = text(input.projectId, 128);
        const result =
          req.method === "POST"
            ? { folder: await library.createFolder(projectId, input.path) }
            : req.method === "PUT"
              ? { folder: await library.moveFolder(projectId, input) }
              : await library.removeFolder(projectId, input);
        respondJson(res, 200, result);
      }),
    },
    {
      path: "/api/project-documents/location",
      method: "PUT",
      handler: protect(async ({ req, res }) => {
        const input = await readJsonBody(req, 8192);
        respondJson(res, 200, await library.moveDocument(text(input.projectId, 128), input));
      }),
    },
    {
      path: "/api/project-documents/trash",
      method: ["GET", "POST", "DELETE"],
      handler: protect(async ({ req, res, url }) => {
        if (req.method === "GET") return respondJson(res, 200, { documents: await library.trashList(project(url)) });
        const input = await readJsonBody(req, 8192),
          projectId = text(input.projectId, 128);
        if (req.method === "POST") return respondJson(res, 200, await library.restore(projectId, input.id));
        await library.trash(projectId, input);
        respondJson(res, 200, { ok: true });
      }),
    },
  ];
}
