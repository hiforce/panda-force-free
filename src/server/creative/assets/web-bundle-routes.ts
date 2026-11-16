import type { Route } from "../../http/router.js";
import type { CreativeAssetRouteServices, CreativeAssetRouteProtection } from "./route-contracts.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { fileDigest, fileText } from "../../project-content/codec-values.js";
import { projectContentId } from "../../project-content/paths.js";
import { readRequestBytes } from "../../request-bytes.js";
import { respondJson } from "../../http/respond.js";
import { DocumentError } from "../../documents/errors.js";
import { creativeAssetId } from "./codec.js";
import { inspectWebBundle, prepareWebBundle, exportWebBundle } from "./web-bundle.js";

/** Bundle endpoints share the asset admission/deadline guard; source parsing never acquires a project write lease. */
export function creativeWebBundleRoutes(
  options: CreativeAssetRouteServices,
  protect: CreativeAssetRouteProtection,
): Route[] {
  return [
    {
      path: "/api/creative-assets/bundle-inspection",
      method: "POST",
      handler: protect(async (ctx, signal) => {
        const project = projectContentId(ctx.url.searchParams.get("project")),
          service = await options.read(options.owner(ctx), project);
        await service.authorize(project);
        const bytes = await readRequestBytes(ctx.req, limits.sourceBytes),
          inspection = await inspectWebBundle(bytes, signal);
        await service.authorize(project);
        if (signal.aborted) throw new DocumentError("unavailable", 503);
        respondJson(ctx.res, 200, inspection);
      }, true),
    },
    {
      path: "/api/creative-assets/import-bundle",
      method: "POST",
      handler: protect(async (ctx, signal) => {
        const q = ctx.url.searchParams,
          owner = options.owner(ctx),
          project = projectContentId(q.get("project")),
          service = await options.write(owner, project),
          input = {
            id: creativeAssetId(q.get("id")),
            operationId: projectContentId(q.get("operationId")),
            kind: "web" as const,
            title: fileText(q.get("title"), 800),
            locale: fileText(q.get("locale"), 35),
            expectedVersion: q.has("version") ? fileDigest(q.get("version")) : null,
          },
          entry = fileText(q.get("entry"), 512),
          bytes = await readRequestBytes(ctx.req, limits.sourceBytes),
          prepared = await prepareWebBundle(bytes, entry, signal);
        respondJson(ctx.res, 201, await service.save(owner, project, { ...input, ...prepared }, signal));
      }, true),
    },
    {
      path: "/api/creative-assets/export-bundle",
      method: "GET",
      handler: protect(async (ctx, signal) => {
        const q = ctx.url.searchParams,
          project = projectContentId(q.get("project")),
          id = creativeAssetId(q.get("id")),
          version = fileDigest(q.get("version")),
          service = await options.read(options.owner(ctx), project),
          original = await service.original(project, id);
        if (original.asset.version !== version) throw new DocumentError("conflict", 409);
        if (original.asset.kind !== "web") throw new DocumentError("invalidInput");
        const bytes = await exportWebBundle({
          name: original.asset.source.name,
          bytes: original.bytes,
          resources: original.resources,
        });
        const current = await service.original(project, id);
        if (current.asset.version !== version) throw new DocumentError("conflict", 409);
        await service.authorize(project);
        if (signal.aborted) throw new DocumentError("unavailable", 503);
        ctx.res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": String(bytes.length),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(id + ".zip"),
        });
        ctx.res.end(bytes);
      }, true),
    },
  ];
}
