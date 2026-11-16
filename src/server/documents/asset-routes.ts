import type { Route, RouteContext } from "../http/router.js";
import { respondJson } from "../http/respond.js";
import { readRequestBytes } from "../request-bytes.js";
import { documentRouteProtection as protect } from "./protection.js";
import { text } from "./validation.js";
import { MAX_ASSET_BYTES } from "./image-decoder.js";
import type { ProjectDocumentAssets } from "./asset-port.js";

export function projectDocumentAssetRoutes(
  assets: ProjectDocumentAssets,
  principal: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/project-documents/assets",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        const { req, res, url } = context,
          projectId = text(url.searchParams.get("project"), 128),
          documentId = text(url.searchParams.get("document"), 128);
        if (req.method === "GET") return respondJson(res, 200, { assets: await assets.list(projectId, documentId) });
        const actor = principal(context),
          name = text(url.searchParams.get("name"), 240),
          operationId = text(url.searchParams.get("operationId"), 128);
        respondJson(res, 201, {
          asset: await assets.upload(
            actor,
            projectId,
            documentId,
            name,
            operationId,
            await readRequestBytes(req, MAX_ASSET_BYTES),
          ),
        });
      }),
    },
    {
      path: "/api/project-documents/assets/content",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const { asset, bytes } = await assets.content(
          text(url.searchParams.get("project"), 128),
          text(url.searchParams.get("id"), 128),
        );
        res.writeHead(200, {
          "content-type": asset.mime,
          "content-length": String(bytes.length),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'",
          "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(asset.name),
        });
        res.end(bytes);
      }),
    },
  ];
}
