import { documentRouteProtection } from "./protection.js";
import { readJsonBody } from "../http/body.js";
import { respondJson, respondReadJson } from "../http/respond.js";
import type { Route } from "../http/router.js";
import { DocumentError } from "./errors.js";
import type { DocumentService } from "./service.js";
import { readRequestBytes } from "../request-bytes.js";
import { MAX_ASSET_BYTES, type DocumentAssets } from "./assets.js";
import type { DocumentLanguages } from "./languages.js";
import { text, expectedVersion } from "./validation.js";
import type { DocumentSourceProfiles } from "./source-profile/service.js";

export function documentRoutes(
  service: DocumentService,
  assets: DocumentAssets,
  languages: DocumentLanguages,
  profiles?: DocumentSourceProfiles,
): Route[] {
  const protect = documentRouteProtection;
  const id = (url: URL) => text(url.searchParams.get("id"), 128);
  return [
    ...(profiles
      ? [
          {
            path: "/api/document-spaces/source-profile",
            method: ["GET", "PUT"],
            handler: protect(async ({ req, res, url }) => {
              const spaceId = id(url);
              if (req.method === "GET")
                return respondJson(res, 200, { space: service.space(spaceId), profile: profiles.get(spaceId) });
              const input = await readJsonBody(req, 128 * 1024);
              respondJson(res, 200, { space: profiles.save(spaceId, input.profile, input.version) });
            }),
          },
          {
            path: "/api/document-spaces/source-profile/options",
            method: "GET",
            handler: protect(async ({ res, url }) => respondJson(res, 200, await profiles.options(id(url)))),
          },
          {
            path: "/api/document-spaces/source-profile/inspect",
            method: "POST",
            handler: protect(async ({ req, res }) => {
              const input = await readJsonBody(req, 8192);
              if (
                !Array.isArray(input.files) ||
                input.files.some((file) => typeof file !== "string") ||
                typeof input.webp !== "boolean"
              )
                throw new DocumentError("invalidInput");
              respondJson(
                res,
                200,
                await profiles.inspect(
                  text(input.id, 128),
                  text(input.locale, 35),
                  input.files as string[],
                  input.webp,
                ),
              );
            }),
          },
        ]
      : []),
    {
      path: "/api/document-spaces/detail",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        respondJson(res, 200, { space: service.space(id(url)) });
      }),
    },
    {
      path: "/api/document-themes",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const engine = url.searchParams.get("engine") || "markdown";
        if (!["markdown", "hexo", "docusaurus"].includes(engine)) throw new DocumentError("invalidInput");
        respondJson(res, 200, {
          themes: service.themes.list(engine as import("../../shared/documents/contracts.js").DocumentEngine),
          defaults: {
            hexo: `${service.themes.resolve("default", "hexo").id}@${service.themes.resolve("default", "hexo").version}`,
            docusaurus: `${service.themes.resolve("default", "docusaurus").id}@${service.themes.resolve("default", "docusaurus").version}`,
          },
        });
      }),
    },
    {
      path: "/api/document-spaces/theme",
      method: "PUT",
      handler: protect(async ({ req, res }) => {
        const input = await readJsonBody(req, 4096);
        respondJson(res, 200, { space: service.updateTheme(text(input.id, 128), input) });
      }),
    },
    {
      path: "/api/documents/import-assets",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = await readJsonBody(req, 4096);
        respondJson(
          res,
          200,
          await service.ingestion.importImages(text(input.id, 128), expectedVersion(input.revision)),
        );
      }),
    },
    {
      path: "/api/document-assets/content",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const { asset, bytes } = await assets.content(id(url));
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
    {
      path: "/api/document-assets",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }) => {
        const documentId = text(url.searchParams.get("document"), 128);
        if (req.method === "GET") return respondJson(res, 200, { assets: assets.list(documentId) });
        respondJson(res, 201, {
          asset: await assets.upload(
            documentId,
            text(url.searchParams.get("name"), 240),
            await readRequestBytes(req, MAX_ASSET_BYTES),
          ),
        });
      }),
    },
    {
      path: "/api/document-languages",
      method: ["GET", "POST", "DELETE"],
      handler: protect(async ({ req, res, url }) => {
        const documentId = id(url);
        const documents =
          req.method === "GET"
            ? languages.list(documentId)
            : req.method === "DELETE"
              ? languages.unlink(documentId)
              : languages.link(documentId, text((await readJsonBody(req)).otherId, 128));
        respondJson(res, 200, { documents });
      }),
    },
    {
      path: "/api/document-spaces/inspect",
      method: "POST",
      handler: protect(async ({ req, res }) =>
        respondJson(res, 200, await service.sources.inspect(text((await readJsonBody(req)).path, 4096))),
      ),
    },
    {
      path: "/api/document-spaces/import",
      method: "POST",
      handler: protect(async ({ req, res }) =>
        respondJson(res, 200, await service.importSource(text((await readJsonBody(req)).spaceId, 128))),
      ),
    },
    {
      path: "/api/document-spaces",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }) => {
        if (req.method === "GET")
          return respondJson(res, 200, { spaces: service.listSpaces(text(url.searchParams.get("project"), 128)) });
        respondJson(res, 201, { space: await service.createSpace(await readJsonBody(req)) });
      }),
    },
    {
      path: "/api/documents/revisions",
      method: "GET",
      handler: protect(({ res, url }) => {
        const documentId = id(url);
        service.detail(documentId);
        respondJson(
          res,
          200,
          url.searchParams.has("revision")
            ? { revision: service.documents.revision(documentId, text(url.searchParams.get("revision"), 128)) }
            : { revisions: service.documents.revisions(documentId) },
        );
      }),
    },
    {
      path: "/api/documents/detail",
      method: ["GET", "PUT"],
      handler: protect(async ({ req, res, url }) => {
        const documentId = id(url);
        if (req.method === "GET") return respondReadJson(req, res, 200, service.detail(documentId));
        const input = await readJsonBody(req, 6 * 1024 * 1024);
        respondJson(res, 200, service.saveDocument(documentId, input));
      }),
    },
    {
      path: "/api/documents",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }) => {
        if (req.method === "GET")
          return respondJson(
            res,
            200,
            service.listDocuments(
              text(url.searchParams.get("space"), 128),
              url.searchParams.get("search") || "",
              Number(url.searchParams.get("offset") || 0),
            ),
          );
        respondJson(res, 201, service.createDocument(await readJsonBody(req, 6 * 1024 * 1024)));
      }),
    },
  ];
}
