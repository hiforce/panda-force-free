import { expect, test } from "bun:test";
import type { Route, RouteContext } from "../../src/server/http/router.js";
import { projectDocumentPreviewRoutes } from "../../src/server/documents/preview/routes.js";

test("project preview capabilities and tree dispatch await native storage selection without invoking both backends", async () => {
  for (const files of [false, true]) {
    let current = 0,
      legacy = 0,
      authorized = 0;
    const file: Route = {
        path: "/api/project-document-tree",
        method: "GET",
        handler: async () => {
          current++;
        },
      },
      old: Route = {
        ...file,
        handler: async () => {
          legacy++;
        },
      };
    const routes = projectDocumentPreviewRoutes({
      fileRoutes: [file],
      legacyRoutes: [old],
      usesFiles: async () => {
        await Bun.sleep(1);
        return files;
      },
      requireProject: () => {},
      authorizeProject: async (_ctx, id) => {
        expect(id).toBe("project");
        authorized++;
      },
    });
    let body: any,
      status = 0;
    const context = {
      req: { method: "GET", headers: {} },
      url: new URL("http://fixture/api/project-documents/capabilities?project=project"),
      res: {
        writeHead(value: number) {
          status = value;
        },
        end(value: string) {
          body = JSON.parse(value);
        },
      },
    } as unknown as RouteContext;
    await routes[0]!.handler(context);
    expect(status).toBe(200);
    expect(body.preview).toBe(files);
    expect(body.storage).toBe(files ? "files" : "legacy");
    context.url = new URL("http://fixture/api/project-document-tree?project=project");
    await routes.find((route) => route.path === "/api/project-document-tree")!.handler(context);
    expect(current).toBe(files ? 1 : 0);
    expect(legacy).toBe(files ? 0 : 1);
    expect(authorized).toBe(2);
  }
});
