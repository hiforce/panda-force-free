import type { MetadataStore } from "../../../shared/async-value.js";
import type { ChannelTemplateCatalog } from "../../../shared/presentation/templates.js";
import type { VariantStore } from "../ports.js";
import { auditPrincipal } from "../../auth/audit-principal.js";
import type { Route, RouteContext } from "../../http/router.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import type { VariantService } from "../variant-service.js";
import type { VariantExporter } from "../export-service.js";
import { PublicationError } from "../errors.js";

function field(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new PublicationError("invalidInput");
  return value.trim();
}
function reviewer(context: RouteContext): string {
  try {
    return auditPrincipal(context.idaasSession?.identity);
  } catch {
    throw new PublicationError("unavailable", 503);
  }
}
export function publishingRoutes(
  variants: VariantService<VariantStore, MetadataStore<ChannelTemplateCatalog>>,
  exporter: VariantExporter,
): Route[] {
  const protect =
    (handler: Route["handler"]): Route["handler"] =>
    async (context) => {
      try {
        const { req } = context;
        if (
          req.method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: req.headers.host,
            origin: req.headers.origin,
            fetchSite: req.headers["sec-fetch-site"],
          })
        )
          throw new PublicationError("crossOrigin", 403);
        await handler(context);
      } catch (error) {
        if (error instanceof PublicationError)
          return respondJson(context.res, error.status, {
            ...errorPayload(`publishing.${error.code}`),
            code: error.code,
          });
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("publishing.invalidInput"));
        reportDiagnostic("publishing-api", error);
        respondJson(context.res, 503, errorPayload("publishing.unavailable"));
      }
    };
  return [
    {
      path: "/api/publication-templates",
      method: "GET",
      handler: protect(async ({ res }) => {
        respondJson(res, 200, { templates: await variants.templates() });
      }),
    },
    {
      path: "/api/publication-variants",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }) => {
        if (req.method === "GET")
          return respondJson(res, 200, {
            variants: await variants.list(
              field(url.searchParams.get("document")),
              url.searchParams.get("project") ?? undefined,
            ),
          });
        respondJson(res, 201, await variants.prepare(await readJsonBody(req)));
      }),
    },
    {
      path: "/api/publication-variants/detail",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(res, 200, await variants.detail(field(url.searchParams.get("id")))),
      ),
    },
    {
      path: "/api/publication-variants/review",
      method: "POST",
      handler: protect(async (context) => {
        const input = await readJsonBody(context.req);
        respondJson(context.res, 200, await variants.review(field(input.id), input, reviewer(context)));
      }),
    },
    {
      path: "/api/publication-variants/export",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const kind = url.searchParams.get("kind");
        if (kind !== "html" && kind !== "text" && kind !== "bundle") throw new PublicationError("invalidInput");
        const result = await exporter.export(field(url.searchParams.get("id")), kind);
        res.writeHead(200, {
          "content-type": result.mime,
          "content-length": String(result.bytes.length),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(result.name),
        });
        res.end(result.bytes);
      }),
    },
    {
      path: "/api/publication-proofread",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }) => {
        if (req.method === "GET")
          return respondJson(res, 200, {
            suggestions: await variants.proofreading(
              field(url.searchParams.get("document")),
              field(url.searchParams.get("revision")),
              url.searchParams.get("project") ?? undefined,
            ),
          });
        const input = await readJsonBody(req);
        respondJson(
          res,
          200,
          await variants.proofreadProposal(
            field(input.documentId),
            field(input.revisionId),
            input.selected,
            input.projectId === undefined ? undefined : field(input.projectId),
          ),
        );
      }),
    },
  ];
}
