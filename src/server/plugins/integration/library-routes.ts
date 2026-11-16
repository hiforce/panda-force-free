import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { packageRecord, packageText } from "../../../shared/plugins/validation.js";
import { TEMPLATE_LIBRARY_LIMITS } from "../../../shared/plugins/library.js";
import type { PluginApproval } from "../ports.js";
import type { TemplateLibraryServicePort } from "../library-service.js";
import { pluginRouteProtection } from "./protect.js";
/** Authenticated maintenance and preview never invoke a channel publisher. */
export function templateLibraryRoutes(
  library: TemplateLibraryServicePort,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = pluginRouteProtection(owner),
    id = (url: URL) => packageText(url.searchParams.get("id"), 128);
  return [
    {
      path: "/api/template-library",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res }, actor) => {
        if (req.method === "GET") return respondJson(res, 200, await library.snapshot());
        respondJson(res, 201, {
          draft: await library.save(await readJsonBody(req, TEMPLATE_LIBRARY_LIMITS.jsonBytes), actor),
        });
      }),
    },
    {
      path: "/api/template-library/draft",
      method: ["GET", "PUT", "DELETE"],
      handler: protect(async ({ req, res, url }, actor) => {
        if (req.method === "GET") return respondJson(res, 200, { draft: await library.detail(id(url)) });
        const input = packageRecord(
          await readJsonBody(req, TEMPLATE_LIBRARY_LIMITS.jsonBytes + 4096),
          req.method === "PUT" ? ["definition", "revision"] : ["revision"],
        );
        if (req.method === "DELETE") {
          await library.remove(id(url), input.revision, actor);
          return respondJson(res, 200, { ok: true });
        }
        respondJson(res, 200, { draft: await library.save(input.definition, actor, id(url), input.revision) });
      }),
    },
    {
      path: "/api/template-library/fork",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "version", "fromVersion"]);
        respondJson(res, 201, {
          draft:
            input.fromVersion === undefined
              ? await library.fork(packageText(input.id, 128), packageText(input.version, 14), actor)
              : await library.forkRelease(
                  packageText(input.id, 128),
                  packageText(input.fromVersion, 14),
                  packageText(input.version, 14),
                  actor,
                ),
        });
      }),
    },
    {
      path: "/api/template-library/baseline",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "revision", "fixtureId", "digest"]);
        respondJson(res, 200, {
          draft: await library.acceptBaseline(
            packageText(input.id, 128),
            input.revision,
            packageText(input.fixtureId, 80),
            packageText(input.digest, 64),
            actor,
          ),
        });
      }),
    },
    {
      path: "/api/template-library/preview",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "fixtureId"]);
        respondJson(res, 200, await library.preview(packageText(input.id, 128), packageText(input.fixtureId, 80)));
      }),
    },
    {
      path: "/api/template-library/validate",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 4096), ["id", "revision"]);
        respondJson(res, 200, { draft: await library.validate(packageText(input.id, 128), input.revision, actor) });
      }),
    },
    {
      path: "/api/template-library/publish",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = packageRecord(await readJsonBody(req, 8192), ["id", "revision", "digest", "approval"]),
          approval = packageRecord(input.approval, ["digest", "expectedRevision", "permissions"]);
        respondJson(res, 201, {
          release: await library.publish(
            packageText(input.id, 128),
            input.revision,
            packageText(input.digest, 64),
            approval as unknown as PluginApproval,
            actor,
          ),
        });
      }),
    },
    {
      path: "/api/template-library/release",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(res, 200, {
          release: await library.release(id(url), packageText(url.searchParams.get("version"), 14)),
        }),
      ),
    },
  ];
}
