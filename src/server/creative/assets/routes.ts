import { CreativeAssetSlots } from "./slots.js";
import { ObjectStorageError } from "../../object-storage/contracts.js";
import { originalStorageErrorMessages } from "../../../shared/storage/messages.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { CREATIVE_ASSET_KINDS } from "../../../shared/creative/assets.js";
import { creativeFilePreview } from "../../../shared/creative/file-types.js";
import {
  respondCreativeInline,
  respondCreativeBytes,
  creativeByteSelection,
  type CreativeByteSelection,
} from "./inline.js";
import { CreativeAssetCovers } from "./covers.js";
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
  const slots = new CreativeAssetSlots(),
    covers = new CreativeAssetCovers();
  const protect = (
    handler: (context: RouteContext, signal: AbortSignal) => unknown | Promise<unknown>,
    heavy = false,
  ) =>
    documentRouteProtection(async (ctx) => {
      const controller = new AbortController(),
        abort = () => {
          if (!ctx.res.writableEnded) controller.abort();
        };
      ctx.req.once("aborted", abort);
      ctx.res.once("close", abort);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
      let release = () => {};
      try {
        if (heavy) release = await slots.acquire(options.owner(ctx), signal);
        if (signal.aborted) throw new DocumentError("unavailable", 503);
        await handler(ctx, signal);
      } catch (error) {
        if (error instanceof ObjectStorageError) {
          respondJson(
            ctx.res,
            error.code === "storageConflict"
              ? 409
              : ["storageDenied", "storageAuthenticationRequired"].includes(error.code)
                ? 403
                : 503,
            {
              ...errorPayload(
                error.code === "storageConflict" ? "documents.conflict" : originalStorageErrorMessages[error.code],
              ),
              code: error.code,
              retryable: error.retryable,
            },
            { "cache-control": "private, no-store" },
          );
          return;
        }
        if (error instanceof ProjectContentError && error.code === "invalidFile")
          throw new DocumentError("invalidInput");
        throw error;
      } finally {
        ctx.req.removeListener("aborted", abort);
        ctx.res.removeListener("close", abort);
        release();
      }
    });
  return [
    ...creativeWebBundleRoutes(options, protect),
    {
      path: "/api/creative-assets/link",
      method: "GET",
      handler: protect(async (ctx, signal) => {
        const project = projectContentId(ctx.url.searchParams.get("project")),
          service = await options.read(options.owner(ctx), project),
          link = await service.delivery(project, creativeAssetId(ctx.url.searchParams.get("id")), {
            version: fileDigest(ctx.url.searchParams.get("version")),
            signal,
          });
        if (!link) throw new DocumentError("invalidInput");
        respondJson(ctx.res, 200, link, { "cache-control": "private, no-store" });
      }),
    },
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
          kind = fileChoice(q.get("kind"), CREATIVE_ASSET_KINDS),
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
          value = await service.detail(project, creativeAssetId(ctx.url.searchParams.get("id")), signal);
        respondJson(ctx.res, 200, {
          asset: value.asset,
          text: value.text,
          sections: value.sections,
          ...(value.previewHtml ? { previewHtml: value.previewHtml } : {}),
          ...(value.previewTruncated ? { previewTruncated: true } : {}),
          ...(value.previewUnavailable ? { previewUnavailable: true } : {}),
        });
      }, true),
    },
    {
      path: "/api/creative-assets/content",
      method: ["GET", "HEAD"],
      handler: protect(async (ctx, signal) => {
        const project = projectContentId(ctx.url.searchParams.get("project")),
          service = await options.read(options.owner(ctx), project),
          name = ctx.url.searchParams.get("resource") ?? undefined,
          id = creativeAssetId(ctx.url.searchParams.get("id")),
          version = ctx.url.searchParams.has("version") ? fileDigest(ctx.url.searchParams.get("version")) : undefined;
        if (ctx.req.method === "GET" && version) {
          const link = await service.delivery(project, id, { name, version, signal, attachment: true });
          if (link) {
            redirectOriginal(ctx, link.url);
            return;
          }
        }
        const value = await service.resource(project, id, {
          name,
          signal,
          version: ctx.url.searchParams.has("version") ? fileDigest(ctx.url.searchParams.get("version")) : undefined,
          select: () => ({ head: ctx.req.method === "HEAD" }),
        });
        ctx.res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(value.resource.size),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cross-origin-resource-policy": "same-origin",
          "referrer-policy": "no-referrer",
          "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(value.resource.name),
        });
        ctx.res.end(value.bytes);
      }, true),
    },
    {
      path: "/api/creative-assets/view",
      method: ["GET", "HEAD"],
      handler: protect(async (ctx, signal) => {
        const project = projectContentId(ctx.url.searchParams.get("project")),
          service = await options.read(options.owner(ctx), project),
          variant = ctx.url.searchParams.get("variant");
        if (variant !== null && variant !== "cover") throw new DocumentError("invalidInput");
        const id = creativeAssetId(ctx.url.searchParams.get("id")),
          version = fileDigest(ctx.url.searchParams.get("version"));
        if (variant === "cover") {
          const cover = await covers.read(options.owner(ctx), service, project, id, version, signal);
          ctx.res.setHeader("x-panda-image-width", String(cover.width));
          ctx.res.setHeader("x-panda-image-height", String(cover.height));
          respondCreativeInline(ctx, cover.bytes, "image/webp", "cover.webp", version + "-cover-v1");
          return;
        }
        let selection: CreativeByteSelection | undefined;
        if (ctx.req.method === "GET") {
          const link = await service.delivery(project, id, {
            version,
            signal,
            attachment: false,
            select: (_asset, resource) => {
              selection = creativeByteSelection(ctx, resource.size, resource.digest);
              return { head: selection.head };
            },
          });
          if (link) {
            redirectOriginal(ctx, link.url);
            return;
          }
        }
        const value = await service.resource(project, id, {
          signal,
          version,
          select: (asset, resource) => {
            const preview = creativeFilePreview(resource.name);
            if (["slides", "web"].includes(asset.kind) || preview.kind === "download")
              throw new DocumentError("invalidInput");
            selection = creativeByteSelection(ctx, resource.size, resource.digest);
            return { head: selection.head, range: selection.range };
          },
        });
        respondCreativeBytes(
          ctx,
          value.bytes,
          creativeFilePreview(value.resource.name).mime,
          value.resource.name,
          value.resource.digest,
          selection!,
        );
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
      path: "/api/creative-assets/permanent-delete",
      method: "POST",
      handler: protect(async (ctx) => {
        const body = fileRecord(await readJsonBody(ctx.req), ["project", "id", "version", "operationId"]),
          owner = options.owner(ctx),
          project = projectContentId(body.project),
          service = await options.write(owner, project);
        respondJson(
          ctx.res,
          202,
          await service.permanentDelete(
            owner,
            project,
            creativeAssetId(body.id),
            fileDigest(body.version),
            projectContentId(body.operationId),
          ),
          { "cache-control": "private, no-store" },
        );
      }),
    },
    {
      path: "/api/creative-assets/purge",
      method: ["GET", "POST"],
      handler: protect(async (ctx) => {
        const body =
            ctx.req.method === "POST"
              ? fileRecord(await readJsonBody(ctx.req), ["project", "id"])
              : { project: ctx.url.searchParams.get("project"), id: ctx.url.searchParams.get("id") },
          owner = options.owner(ctx),
          project = projectContentId(body.project),
          service = await options.write(owner, project);
        respondJson(
          ctx.res,
          200,
          await service.purgeStatus(project, creativeAssetId(body.id), ctx.req.method === "POST"),
          { "cache-control": "private, no-store" },
        );
      }),
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

/** The application grants access; object bytes travel from the private provider to the browser. */
function redirectOriginal(ctx: RouteContext, url: string) {
  ctx.res.writeHead(307, {
    location: url,
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "content-length": "0",
    "x-content-type-options": "nosniff",
  });
  ctx.res.end();
}
