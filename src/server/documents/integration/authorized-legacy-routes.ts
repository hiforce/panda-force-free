import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { documentRouteProtection } from "../protection.js";
import { text } from "../validation.js";

type Result<T> = T | Promise<T>;
export interface LegacyDocumentScopeReads {
  service: {
    record(id: string): Result<{ spaceId: string }>;
    space(id: string): Result<{ projectId: string }>;
  };
  assets: { metadata(id: string): Result<{ documentId: string }> };
  placements: { get(id: string): Result<{ documentId: string; spaceId: string }> };
  languages: { list(id: string): Result<{ id: string }[]> };
}

/** Global document, revision and image IDs resolve to their current project before any response or mutation. */
export function authorizedLegacyDocumentRoutes(
  routes: Route[],
  reads: LegacyDocumentScopeReads,
  authorize: (context: RouteContext, project: string) => Promise<void>,
): Route[] {
  const space = async (id: unknown) => (await reads.service.space(text(id, 128))).projectId;
  const document = async (id: unknown) => space((await reads.service.record(text(id, 128))).spaceId);
  return routes.map((route) => ({
    ...route,
    handler: documentRouteProtection(async (context) => {
      const { req, url } = context,
        path = url.pathname;
      const body = () => readJsonBody(req, 6 * 1024 * 1024);
      const projects: string[] = [];
      const doc = async (id: unknown) => {
        projects.push(await document(id));
      };
      if (path.startsWith("/api/project-documents") || path.startsWith("/api/project-document-tree"))
        projects.push(text(req.method === "GET" ? url.searchParams.get("project") : (await body()).projectId, 128));
      else if (path === "/api/document-assets/content")
        await doc((await reads.assets.metadata(text(url.searchParams.get("id"), 128))).documentId);
      else if (path === "/api/document-assets") await doc(url.searchParams.get("document"));
      else if (["/api/documents/detail", "/api/documents/revisions"].includes(path))
        await doc(url.searchParams.get("id"));
      else if (path === "/api/documents/import-assets") await doc((await body()).id);
      else if (path === "/api/document-languages") {
        const id = text(url.searchParams.get("id"), 128);
        await doc(id);
        if (req.method === "POST") await doc((await body()).otherId);
        if (req.method === "GET") for (const item of await reads.languages.list(id)) await doc(item.id);
      } else if (path === "/api/documents")
        projects.push(await space(req.method === "GET" ? url.searchParams.get("space") : (await body()).spaceId));
      else if (path === "/api/document-spaces")
        projects.push(text(req.method === "GET" ? url.searchParams.get("project") : (await body()).projectId, 128));
      else if (path.startsWith("/api/document-spaces/") && path !== "/api/document-spaces/inspect") {
        const id =
          url.searchParams.get("id") ?? (path.endsWith("/import") ? (await body()).spaceId : (await body()).id);
        projects.push(await space(id));
      } else if (path === "/api/document-placements") {
        const input =
          req.method === "GET"
            ? { documentId: url.searchParams.get("document"), spaceId: url.searchParams.get("space") }
            : await body();
        if (input.documentId) await doc(input.documentId);
        if (input.spaceId) projects.push(await space(input.spaceId));
      } else if (path.startsWith("/api/document-placements/")) {
        const placement = await reads.placements.get(text(url.searchParams.get("id"), 128));
        await doc(placement.documentId);
        projects.push(await space(placement.spaceId));
      }
      for (const project of new Set(projects)) await authorize(context, project);
      await route.handler(context);
    }),
  }));
}
