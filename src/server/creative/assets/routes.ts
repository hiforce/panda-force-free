import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { readRequestBytes } from "../../request-bytes.js";
import { DocumentError } from "../../documents/errors.js";
import { documentRouteProtection } from "../../documents/protection.js";
import { fileChoice, fileDigest, fileRecord, fileText } from "../../project-content/codec-values.js";
import { projectContentId } from "../../project-content/paths.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { creativeAssetId } from "./codec.js";
import type { CreativeAssetRouteServices } from "./route-contracts.js";
import { creativeWebBundleRoutes } from "./web-bundle-routes.js";

/** Root selection is an application authorization decision, never a path, package type or client-supplied owner. */
export function creativeAssetRoutes(options: CreativeAssetRouteServices): Route[] {
  const active = new Map<string, number>();
  let total = 0;
  const protect = (
    handler: (context: RouteContext, signal: AbortSignal) => unknown | Promise<unknown>,
    heavy = false,
  ) =>
    documentRouteProtection(async (ctx) => {
      const owner = heavy ? options.owner(ctx) : "",
        count = active.get(owner) ?? 0;
      if (heavy && (count >= 2 || total >= 4)) throw new DocumentError("busy", 429);
      if (heavy) {
        active.set(owner, count + 1);
        total++;
      }
      const controller = new AbortController(),
        abort = () => {
          if (!ctx.res.writableEnded) controller.abort();
        };
      ctx.req.once("aborted", abort);
      ctx.res.once("close", abort);
      try {
        await handler(ctx, AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]));
      } catch (error) {
        if (error instanceof ProjectContentError && error.code === "invalidFile")
          throw new DocumentError("invalidInput");
        throw error;
      } finally {
        ctx.req.removeListener("aborted", abort);
        ctx.res.removeListener("close", abort);
        if (heavy) {
          total--;
          const remaining = (active.get(owner) ?? 1) - 1;
          if (remaining) active.set(owner, remaining);
          else active.delete(owner);
        }
      }
    });
  return [
    ...creativeWebBundleRoutes(options, protect),
    {
      path: "/api/creative-assets/capabilities",
      method: "GET",
      handler: protect(async (ctx) => {
        const owner = options.owner(ctx),
          project = projectContentId(ctx.url.searchParams.get("project"));
        if (options.capabilities) {
          respondJson(ctx.res, 200, await options.capabilities(owner, project));
          return;
        }
        await (await options.read(owner, project)).authorize(project);
        respondJson(ctx.res, 200, { contribute: (await options.canWrite?.(owner, project)) ?? false });
      }),
    },
    {
      path: "/api/creative-assets",
      method: "GET",
      handler: protect(async (ctx) => {
        const project = projectContentId(ctx.url.searchParams.get("project"));
        const state = ctx.url.searchParams.has("state")
          ? fileChoice(ctx.url.searchParams.get("state"), ["saved", "trashed"])
          : "saved";
        const owner = options.owner(ctx),
          cursor = ctx.url.searchParams.get("cursor") ?? undefined;
        respondJson(
          ctx.res,
          200,
          options.list
            ? await options.list(owner, project, cursor, state)
            : await (await options.read(owner, project)).list(project, cursor, state),
        );
      }),
    },
    {
      path: "/api/creative-assets/import",
      method: "POST",
      handler: protect(async (ctx, signal) => {
        const q = ctx.url.searchParams,
          owner = options.owner(ctx),
          project = projectContentId(q.get("project")),
          service = await options.write(owner, project),
          kind = fileChoice(q.get("kind"), ["web", "slides"]),
          input = {
            id: creativeAssetId(q.get("id")),
            operationId: projectContentId(q.get("operationId")),
            kind,
            title: fileText(q.get("title"), 800),
            locale: fileText(q.get("locale"), 35),
            name: fileText(q.get("name"), 512),
            expectedVersion: q.has("version") ? fileDigest(q.get("version")) : null,
          };
        const bytes = await readRequestBytes(ctx.req, kind === "web" ? limits.htmlBytes : limits.sourceBytes);
        respondJson(ctx.res, 201, await service.save(owner, project, { ...input, bytes }, signal));
      }, true),
    },
    {
      path: "/api/creative-assets/item",
      method: "GET",
      handler: protect(async (ctx, signal) => {
        const project = projectContentId(ctx.url.searchParams.get("project")),
          service = await options.read(options.owner(ctx), project),
          value = await service.read(project, creativeAssetId(ctx.url.searchParams.get("id")), signal, true);
        respondJson(ctx.res, 200, {
          asset: value.asset,
          text: value.text,
          sections: value.sections,
          ...(value.previewHtml ? { previewHtml: value.previewHtml } : {}),
        });
      }, true),
    },
    {
      path: "/api/creative-assets/content",
      method: "GET",
      handler: protect(async (ctx) => {
        const project = projectContentId(ctx.url.searchParams.get("project")),
          service = await options.read(options.owner(ctx), project),
          value = await service.original(project, creativeAssetId(ctx.url.searchParams.get("id"))),
          name = ctx.url.searchParams.get("resource"),
          resource =
            name === null
              ? { name: value.asset.source.name, bytes: value.bytes }
              : value.resources.find((r) => r.name === name);
        if (
          ctx.url.searchParams.has("version") &&
          fileDigest(ctx.url.searchParams.get("version")) !== value.asset.version
        )
          throw new DocumentError("conflict", 409);
        if (!resource) throw new DocumentError("notFound", 404);
        ctx.res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(resource.bytes.length),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(resource.name),
        });
        ctx.res.end(resource.bytes);
      }, true),
    },
    {
      path: "/api/creative-assets/copy",
      method: "POST",
      handler: protect(async (ctx, signal) => {
        const body = fileRecord(await readJsonBody(ctx.req), [
            "project",
            "id",
            "version",
            "targetProject",
            "targetId",
            "operationId",
          ]),
          owner = options.owner(ctx),
          project = projectContentId(body.project),
          target = projectContentId(body.targetProject),
          source = await options.read(owner, project),
          destination = await options.write(owner, target);
        respondJson(
          ctx.res,
          201,
          await destination.copyFrom(
            source,
            owner,
            { project, id: creativeAssetId(body.id), version: fileDigest(body.version) },
            target,
            creativeAssetId(body.targetId),
            projectContentId(body.operationId),
            signal,
          ),
        );
      }, true),
    },
    {
      path: "/api/creative-assets/availability",
      method: "POST",
      handler: protect(async (ctx) => {
        const body = fileRecord(await readJsonBody(ctx.req), ["project", "id", "version", "state", "operationId"]),
          owner = options.owner(ctx),
          project = projectContentId(body.project),
          service = await options.write(owner, project);
        respondJson(
          ctx.res,
          200,
          await service.setState(
            owner,
            project,
            creativeAssetId(body.id),
            fileDigest(body.version),
            fileChoice(body.state, ["saved", "trashed"]),
            projectContentId(body.operationId),
          ),
        );
      }),
    },
  ];
}
