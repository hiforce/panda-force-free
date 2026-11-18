import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileDocumentApplication } from "../../src/server/documents/files/application.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { createRouter } from "../../src/server/http/router.js";
import { respondJson } from "../../src/server/http/respond.js";
import type { Route } from "../../src/server/http/router.js";
import { projectDraftFixture } from "./project-draft-fixture.js";

/** A real HTTP boundary and real file/Git store; the test host supplies authentication without starting a shared engine. */
export async function projectFileApiFixture(
  options: {
    allowedRoots?: string[];
    extraRoutes?: Route[];
    originalStorage?: (
      root: string,
      assetRoot: string,
    ) => NonNullable<Parameters<typeof createFileDocumentApplication>[0]["originalStorage"]>;
  } = {},
) {
  const files = await projectDraftFixture(),
    assetRoot = await mkdtemp(join(tmpdir(), "panda-file-assets-")),
    root = resolve(files.owned.directory, "../.."),
    grants = new Set(["project-1"]),
    authorization = "Bearer isolated-document-test";
  const originalStorage = options.originalStorage?.(root, assetRoot);
  let actor = "operator:test-user";
  const server = createServer(),
    state = { authorizations: 0 };
  let application: ReturnType<typeof createFileDocumentApplication>;
  function reopen() {
    application = createFileDocumentApplication({
      root,
      assetRoot,
      originalStorage,
      authorizeUnderLease(id) {
        if (!grants.has(id)) throw new DocumentError("notFound", 404);
      },
      allowedRoots: options.allowedRoots,
      requireProject(id) {
        state.authorizations++;
        if (!grants.has(id)) throw new DocumentError("notFound", 404);
      },
      principal: () => actor,
    });
  }
  reopen();
  server.on("request", async (req, res) => {
    try {
      if (req.headers.authorization !== authorization) return respondJson(res, 401, { error: "Unauthorized" });
      const dispatch = createRouter([...application.routes, ...(options.extraRoutes ?? [])]);
      if (!(await dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) })))
        respondJson(res, 404, { error: "Not found" });
    } catch {
      respondJson(res, 500, { error: "Test host failure" });
    }
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    return {
      ...files,
      root,
      assetRoot,
      base,
      grants,
      state,
      reopen,
      application: () => application,
      actor: (value: string) => {
        actor = value;
      },
      raw(path: string, method = "GET", body?: Uint8Array, headers: Record<string, string> = {}) {
        return fetch(base + path, {
          method,
          headers: { authorization, origin: base, "content-type": "application/octet-stream", ...headers },
          ...(body === undefined ? {} : { body: Buffer.from(body) }),
        });
      },
      async call(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
        const result = await fetch(base + path, {
          method,
          headers: { authorization, origin: base, "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: result.status, body: await result.json() };
      },
      async close() {
        await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
        await originalStorage?.purges.close();
        await files.close();
        await rm(assetRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await files.close();
    await rm(assetRoot, { recursive: true, force: true });
    throw error;
  }
}
