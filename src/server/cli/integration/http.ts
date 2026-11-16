import { randomUUID } from "node:crypto";
import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { CliError } from "../../../shared/cli/contracts.js";
import type { CliCredentials } from "../auth/service.js";
import { executeCliCommand, type CliContentCommands } from "../commands.js";
function reject(context: RouteContext, error: unknown, requestId: string) {
  const known = error instanceof CliError || error instanceof RequestBodyError;
  // Authentication can reject a request before its body is consumed; do not reuse that socket.
  context.res.setHeader("connection", "close");
  respondJson(
    context.res,
    known ? error.status : 503,
    {
      schema: 1,
      requestId,
      error: {
        code:
          error instanceof CliError ? error.code : error instanceof RequestBodyError ? "invalidInput" : "unavailable",
      },
    },
    { "cache-control": "no-store" },
  );
}
function deadline(context: RouteContext, controller: AbortController, requestId: string, timeoutMs: number) {
  return setTimeout(() => {
    controller.abort(new CliError("unavailable", 503));
    const { req, res } = context;
    if (!res.writableEnded && !res.destroyed) {
      if (!req.complete) res.once("finish", () => req.destroy());
      reject(context, new CliError("unavailable", 503), requestId);
    }
  }, timeoutMs);
}
/** This handler runs before browser auth and requires its own registered-client credentials even on loopback. */
export function cliApiRoute(
  credentials: CliCredentials,
  commands: CliContentCommands,
  options: { timeoutMs?: number } = {},
): Route {
  const keys = new Map<string, number>(),
    owners = new Map<string, number>(),
    timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new CliError("invalidInput");
  return {
    path: (path) => path === "/api/cli/v1" || path.startsWith("/api/cli/v1/"),
    handler: async (context) => {
      const requestId = randomUUID(),
        { req, res, url } = context;
      res.setHeader("cache-control", "no-store");
      const controller = new AbortController(),
        abort = () => {
          if (!res.writableEnded) controller.abort();
        };
      let timer: ReturnType<typeof setTimeout> | undefined;
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        const authorization = req.headers.authorization;
        if (
          req.headers.origin ||
          req.headers.cookie ||
          req.headers["x-panda-cli-protocol"] !== "1" ||
          !authorization?.startsWith("Bearer ") ||
          url.search
        )
          throw new CliError("authenticationRequired", 401);
        const client = req.headers["x-panda-client-id"],
          token = authorization.slice(7),
          grant = await credentials.authenticate(client, token);
        if (
          req.method === "GET" &&
          (Number(req.headers["content-length"] || 0) !== 0 || req.headers["transfer-encoding"])
        )
          throw new CliError("invalidInput");
        timer = deadline(context, controller, requestId, timeoutMs);
        if (url.pathname === "/api/cli/v1/session" && req.method === "GET") {
          const { owner: _owner, ...publicGrant } = grant;
          respondJson(res, 200, { schema: 1, requestId, data: publicGrant });
          return;
        }
        if (url.pathname !== "/api/cli/v1/execute") throw new CliError("notFound", 404);
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          res.setHeader("connection", "close");
          respondJson(res, 405, { schema: 1, requestId, error: { code: "invalidInput" } });
          return;
        }
        if ((keys.get(grant.keyId) ?? 0) >= 4 || (owners.get(grant.owner) ?? 0) >= 8) throw new CliError("limit", 429);
        const keyId = grant.keyId;
        keys.set(keyId, (keys.get(keyId) ?? 0) + 1);
        owners.set(grant.owner, (owners.get(grant.owner) ?? 0) + 1);
        try {
          const input = await readJsonBody(req, 1024 * 1024);
          const current = await credentials.authenticate(client, token);
          const result = await executeCliCommand(
            current,
            input,
            commands,
            AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
          );
          await credentials.authenticate(client, token);
          if (!controller.signal.aborted) respondJson(res, 200, { schema: 1, requestId, data: result });
        } finally {
          for (const [map, id] of [
            [keys, keyId],
            [owners, grant.owner],
          ] as const) {
            const count = (map.get(id) ?? 1) - 1;
            if (count) map.set(id, count);
            else map.delete(id);
          }
        }
      } catch (error) {
        if (!res.writableEnded && !res.destroyed) reject(context, error, requestId);
      } finally {
        clearTimeout(timer);
        req.removeListener("aborted", abort);
        res.removeListener("close", abort);
      }
    },
  };
}
export function cliRegistrationRoutes(
  credentials: CliCredentials,
  options: {
    owner(context: RouteContext): string;
    authorize(owner: string, project: string): Promise<void>;
    timeoutMs?: number;
  },
): Route[] {
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new CliError("invalidInput");
  return [
    {
      path: "/api/cli/clients",
      method: ["GET", "POST", "DELETE"],
      handler: async (context) => {
        const requestId = randomUUID(),
          { req, res, url } = context;
        res.setHeader("cache-control", "no-store");
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (url.search) throw new CliError("invalidInput");
          const owner = options.owner(context);
          if (req.method === "GET") {
            respondJson(res, 200, { clients: await credentials.list(owner) });
            return;
          }
          if (
            !req.headers.origin ||
            !matchesRequestOrigin({
              hostHeader: req.headers.host,
              origin: req.headers.origin,
              fetchSite: req.headers["sec-fetch-site"],
            })
          )
            throw new CliError("forbidden", 403);
          timer = deadline(context, controller, requestId, timeoutMs);
          const p = await readJsonBody(req, 16384);
          controller.signal.throwIfAborted();
          if (req.method === "DELETE") {
            if (Object.keys(p).length !== 1) throw new CliError("invalidInput");
            await credentials.revoke(owner, p.clientId);
            respondJson(res, 200, { revoked: true });
            return;
          }
          respondJson(
            res,
            201,
            await credentials.issue(owner, req.headers.origin, p, async (project) => {
              await options.authorize(owner, project);
              controller.signal.throwIfAborted();
            }),
          );
        } catch (error) {
          if (!res.writableEnded && !res.destroyed) reject(context, error, requestId);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  ];
}
