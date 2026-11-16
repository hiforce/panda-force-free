import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { sourceUploadRequest } from "../http/source-upload-body.js";
import { stageId, stagePurpose, stageRevision } from "../../shared/packages/stages/input.js";
import { SourceStageError } from "../../shared/packages/stages/contracts.js";
import type { SourceLimits } from "../../shared/packages/sources/contracts.js";
import type { PackageSourceIngestionPort } from "../packages/ingestion/ports.js";
import { sourceRouteProtection } from "./protect.js";

function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some((name) => !names.includes(name))) throw new SourceStageError("stageInvalidInput");
  return value;
}
function query(context: RouteContext, names: string[]) {
  const params = context.url.searchParams;
  if ([...params.keys()].some((key) => !names.includes(key) || params.getAll(key).length !== 1))
    throw new SourceStageError("stageInvalidInput");
  return params;
}

export function packageSourceRoutes(
  service: PackageSourceIngestionPort,
  owner: (context: RouteContext) => string,
  limits: SourceLimits,
): Route[] {
  const protect = sourceRouteProtection(owner);
  return [
    {
      path: "/api/package-sources/policy",
      method: "GET",
      handler: protect((context) => {
        query(context, []);
        respondJson(context.res, 200, { limits });
      }),
    },
    {
      path: "/api/package-sources",
      method: ["GET", "POST"],
      handler: protect(async (context, actor) => {
        if (context.req.method === "GET") {
          const params = query(context, ["purpose"]);
          return respondJson(context.res, 200, await service.list(actor, stagePurpose(params.get("purpose"))));
        }
        query(context, []);
        const body = fields(await readJsonBody(context.req, 5 * 1024 * 1024), ["purpose", "operationId", "request"]);
        respondJson(
          context.res,
          202,
          await service.submit(actor, stagePurpose(body.purpose), stageId(body.operationId), body.request),
        );
      }),
    },
    ...["task", "inspect"].map((action): Route => ({
      path: `/api/package-sources/${action}`,
      method: "GET",
      handler: protect(async (context, actor) => {
        const params = query(context, ["purpose", "id"]),
          purpose = stagePurpose(params.get("purpose")),
          id = stageId(params.get("id"));
        respondJson(
          context.res,
          200,
          action === "task" ? await service.read(actor, purpose, id) : await service.inspect(actor, purpose, id),
        );
      }),
    })),
    {
      path: "/api/package-sources/upload",
      method: "POST",
      handler: protect(async (context, actor) => {
        const params = query(context, ["purpose", "id", "revision"]),
          purpose = stagePurpose(params.get("purpose")),
          id = stageId(params.get("id")),
          revision = params.get("revision");
        if (!revision || !/^[1-9]\d{0,15}$/.test(revision)) throw new SourceStageError("stageInvalidInput");
        const expected = stageRevision(Number(revision));
        const current = await service.read(actor, purpose, id);
        if (current.request.source.kind !== "zip-upload") throw new SourceStageError("stageInvalidInput");
        const body = sourceUploadRequest(context.req, current.request.source.bytes, () => {
          // End the response before closing a rejected upload, so the caller receives a useful retryable status.
          context.res.shouldKeepAlive = false;
          context.res.setHeader("Connection", "close");
          context.req.resume();
        });
        respondJson(context.res, 200, await service.upload(actor, purpose, id, expected, body));
      }),
    },
    ...["cancel", "remove"].map((action): Route => ({
      path: `/api/package-sources/${action}`,
      method: "POST",
      handler: protect(async (context, actor) => {
        query(context, []);
        const body = fields(await readJsonBody(context.req, 4096), ["purpose", "id", "revision"]),
          purpose = stagePurpose(body.purpose),
          id = stageId(body.id),
          revision = stageRevision(body.revision);
        respondJson(
          context.res,
          200,
          action === "cancel"
            ? await service.cancel(actor, purpose, id, revision)
            : await service.remove(actor, purpose, id, revision),
        );
      }),
    })),
  ];
}
