import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { documentRouteProtection as protect } from "../protection.js";
import { text, MAX_DOCUMENT_BYTES } from "../validation.js";
import { DocumentError } from "../errors.js";

const treePaths = new Set([
  "/api/project-document-tree",
  "/api/project-document-tree/documents",
  "/api/project-document-tree/actions",
  "/api/project-document-tree/trash",
]);

/** Routing selects one authority per project. It never mirrors edits between a file source and the legacy body store. */
export function projectDocumentPreviewRoutes(options: {
  fileRoutes: Route[];
  legacyRoutes: Route[];
  usesFiles(projectId: string): boolean | Promise<boolean>;
  requireProject(projectId: string): unknown;
  fileRoutesFor?(context: RouteContext): Route[];
  authorizeProject?(context: RouteContext, projectId: string): void | Promise<void>;
}): Route[] {
  const fileHandler = (route: Route, context: RouteContext) => {
    const selected = options.fileRoutesFor
      ? options
          .fileRoutesFor(context)
          .find(
            (candidate) =>
              candidate.path === route.path && JSON.stringify(candidate.method) === JSON.stringify(route.method),
          )
      : route;
    if (!selected) throw new DocumentError("unavailable", 503);
    return selected.handler(context);
  };
  const fileTrees = new Map(
    options.fileRoutes
      .filter((route) => typeof route.path === "string" && treePaths.has(route.path))
      .map((route) => [route.path as string, route]),
  );
  return [
    {
      path: "/api/project-documents/capabilities",
      method: "GET",
      handler: protect(async (context) => {
        const { res, url } = context;
        const projectId = text(url.searchParams.get("project"), 128);
        await options.requireProject(projectId);
        await options.authorizeProject?.(context, projectId);
        const files = await options.usesFiles(projectId);
        respondJson(res, 200, {
          storage: files ? "files" : "legacy",
          preview: files,
          publication: true,
          websiteConfiguration: true,
          websiteBuilds: true,
          websitePublishing: true,
        });
      }),
    },
    ...options.fileRoutes
      .filter((route) => typeof route.path !== "string" || !treePaths.has(route.path))
      .map((route): Route => ({ ...route, handler: protect((context) => fileHandler(route, context)) })),
    ...options.legacyRoutes.map((route): Route => {
      if (typeof route.path !== "string" || !treePaths.has(route.path)) return route;
      const file = fileTrees.get(route.path);
      if (!file) throw Error("Missing file tree route");
      return {
        ...route,
        handler: protect(async (context: RouteContext) => {
          const projectId = text(
            context.req.method === "GET"
              ? context.url.searchParams.get("project")
              : (await readJsonBody(context.req, MAX_DOCUMENT_BYTES + 32768)).projectId,
            128,
          );
          await options.authorizeProject?.(context, projectId);
          await ((await options.usesFiles(projectId)) ? fileHandler(file, context) : route.handler(context));
        }),
      };
    }),
  ];
}
