import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { isRecord } from "../../../shared/records.js";
import type { DatabaseConnectionInput, DatabaseMigrationRequest } from "../../../shared/database/contracts.js";
import { DatabaseManagementError } from "./errors.js";
import type { DatabaseManagementService } from "./service.js";

const root = "/api/system/database";
const trusted = (context: RouteContext) =>
  matchesRequestOrigin({
    hostHeader: context.req.headers.host,
    origin: context.req.headers.origin,
    fetchSite: context.req.headers["sec-fetch-site"],
  });
function failure(context: RouteContext, error: unknown) {
  const known = error instanceof DatabaseManagementError;
  respondJson(
    context.res,
    known ? error.status : error instanceof RequestBodyError ? error.status : 503,
    {
      error: {
        code: known
          ? error.code
          : error instanceof RequestBodyError
            ? "invalidDatabaseConfiguration"
            : "databaseUnavailable",
      },
    },
    { "cache-control": "no-store" },
  );
}
async function input(context: RouteContext) {
  const value = await readJsonBody(context.req, 65536);
  if (!isRecord(value)) throw new DatabaseManagementError("invalidDatabaseConfiguration");
  return value;
}
export function databaseManagementRoutes(options: {
  service: DatabaseManagementService;
  owner(context: RouteContext): string;
  administrator(context: RouteContext): boolean;
}) {
  const { service } = options;
  const operation = async (context: RouteContext, capability = false, currentOperationId?: string) => {
    const match = /^\/api\/system\/database\/operations\/([^/]+)(?:\/(retry|cancel))?$/.exec(context.url.pathname);
    if (!match) return false;
    const token = context.req.headers["x-panda-database-operation"];
    if (typeof token !== "string") return false;
    try {
      if (capability) {
        if (!trusted(context)) throw new DatabaseManagementError("administratorRequired", 403);
        const current =
          currentOperationId ?? (await service.options.state.read<{ operationId: string }>("", "pending"))?.operationId;
        if (!current || current !== match[1]) throw new DatabaseManagementError("operationNotFound", 404);
      }
      if (context.req.method === "GET" && !match[2])
        respondJson(context.res, 200, await service.operation(match[1]!, token), { "cache-control": "no-store" });
      else if (context.req.method === "POST" && match[2]) {
        if (!trusted(context) || (!capability && !options.administrator(context)))
          throw new DatabaseManagementError("administratorRequired", 403);
        const body = await input(context);
        if (Object.keys(body).length) throw new DatabaseManagementError("invalidDatabaseConfiguration");
        const result =
          match[2] === "retry" ? await service.retry(match[1]!, token) : await service.cancel(match[1]!, token);
        respondJson(context.res, 200, result, { "cache-control": "no-store" });
        service.scheduleRestart(result);
      } else throw new DatabaseManagementError("operationNotFound", 404);
    } catch (error) {
      failure(context, error);
    }
    return true;
  };
  const routes: Route[] = [
    {
      path: (path) => path === root || path.startsWith(root + "/"),
      method: ["GET", "POST"],
      handler: async (context) => {
        try {
          if (await operation(context)) return;
          const admin = options.administrator(context);
          if (context.req.method === "GET" && context.url.pathname === root) {
            respondJson(context.res, 200, await service.overview(admin), { "cache-control": "no-store" });
            return;
          }
          if (!admin || !trusted(context)) throw new DatabaseManagementError("administratorRequired", 403);
          if (context.req.method !== "POST") throw new DatabaseManagementError("operationNotFound", 404);
          const body = await input(context),
            path = context.url.pathname;
          if (path === root + "/test")
            respondJson(context.res, 200, await service.test(body as unknown as DatabaseConnectionInput), {
              "cache-control": "no-store",
            });
          else if (path === root + "/plan")
            respondJson(
              context.res,
              200,
              await service.plan(options.owner(context), body as unknown as DatabaseConnectionInput),
              { "cache-control": "no-store" },
            );
          else if (path === root + "/migrate") {
            if (
              Object.keys(body).some((k) => !["planId", "requestId", "statusToken"].includes(k)) ||
              typeof body.planId !== "string" ||
              typeof body.requestId !== "string" ||
              typeof body.statusToken !== "string"
            )
              throw new DatabaseManagementError("invalidDatabaseConfiguration");
            const result = await service.migrate(options.owner(context), body as unknown as DatabaseMigrationRequest);
            respondJson(context.res, 202, result, { "cache-control": "no-store" });
            service.scheduleRestart(result);
          } else if (path === root + "/selection" && body.driver === "sqlite" && Object.keys(body).length === 1)
            respondJson(context.res, 200, await service.selectSQLite(), { "cache-control": "no-store" });
          else throw new DatabaseManagementError("operationNotFound", 404);
        } catch (error) {
          failure(context, error);
        }
      },
    },
  ];
  return {
    routes,
    handleCapability: (context: RouteContext, currentOperationId?: string) =>
      operation(context, true, currentOperationId),
  };
}
