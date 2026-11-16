import { THEME_PROTOCOL } from "../shared/builds/theme.js";
import { TRUSTED_THEME_PROTOCOL } from "../shared/builds/trusted-theme.js";
import { SITE_PROJECT_PROTOCOL } from "../shared/builds/project.js";
import { PROFILE_THEME_PROTOCOL } from "../shared/builds/profile-identity.js";
import { timingSafeEqual } from "node:crypto";
import { BUILD_PROTOCOL, BUILD_ENGINES } from "../shared/builds/contracts.js";
import { BUILD_LIMITS, buildInput, buildId, BuildError } from "../shared/builds/validation.js";
import type { ExecutionService } from "./service.js";
import { RESOURCE_BUILD_PROTOCOL } from "../shared/builds/resources.js";
import { RESOURCE_FRAME_CONTENT_TYPE } from "../shared/builds/resource-frame.js";
import { readResourceRequest, readExecutionBody } from "./resource-http.js";
import { HEXO_STYLUS_PROTOCOL } from "../shared/builds/capabilities.js";

export function executionHandler(service: ExecutionService, token: string) {
  const secret = Buffer.from(`Bearer ${token}`);
  let readingResources = false;
  return async (request: Request): Promise<Response> => {
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        await service.ready();
        return json({ ok: true, protocol: BUILD_PROTOCOL });
      }
      const authorization = Buffer.from(request.headers.get("Authorization") || "");
      if (authorization.length !== secret.length || !timingSafeEqual(authorization, secret))
        return json({ error: "unauthorized" }, 401);
      if (path === "/v1/capabilities" && request.method === "GET")
        return json({
          protocol: BUILD_PROTOCOL,
          engines: BUILD_ENGINES,
          features: [
            THEME_PROTOCOL,
            TRUSTED_THEME_PROTOCOL,
            SITE_PROJECT_PROTOCOL,
            PROFILE_THEME_PROTOCOL,
            RESOURCE_BUILD_PROTOCOL,
            HEXO_STYLUS_PROTOCOL,
          ],
        });
      const native = /^\/v2\/builds\/([^/]+)$/.exec(path);
      if (native && request.method === "PUT") {
        let id: string;
        try {
          id = buildId(native[1]!);
        } catch (error) {
          await request.body?.cancel();
          throw error;
        }
        if (request.headers.get("Content-Type") !== RESOURCE_FRAME_CONTENT_TYPE) {
          await request.body?.cancel();
          return json({ error: "unsupportedContentType" }, 415);
        }
        if (readingResources) {
          await request.body?.cancel();
          return json({ error: "executorBusy" }, 429);
        }
        readingResources = true;
        try {
          return json(await service.startResource(id, await readResourceRequest(request)), 202);
        } finally {
          readingResources = false;
        }
      }
      const match = /^\/v1\/builds\/([^/]+)(?:\/(result|logs))?$/.exec(path);
      if (!match) return json({ error: "notFound" }, 404);
      const [, id, action] = match;
      if (request.method === "GET") {
        if (action === "result") return json(await service.result(id));
        if (action === "logs") return json({ logs: service.store.readLogs(id) });
        return json(await service.status(id));
      }
      if (!action && request.method === "DELETE") return json(await service.cancel(id));
      if (!action && request.method === "PUT") {
        if (!(request.headers.get("Content-Type") || "").startsWith("application/json"))
          return json({ error: "unsupportedContentType" }, 415);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await readExecutionBody(request, BUILD_LIMITS.inputBytes, "inputTooLarge"),
        );
        return json(await service.start(id, buildInput(JSON.parse(text))), 202);
      }
      return json({ error: "methodNotAllowed" }, 405);
    } catch (error) {
      return json(
        { error: error instanceof BuildError ? error.code : "executorError" },
        error instanceof BuildError ? error.status : 500,
      );
    }
  };
}
