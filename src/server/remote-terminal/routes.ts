import { REMOTE_CONNECTIONS_PATH, REMOTE_HOST_KEY_PATH } from "../../shared/workspace-tools/remote.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { sharedWorkspaceAllowed } from "../auth/users/access.js";
import { matchesCookieMutationOrigin } from "../auth/origin.js";
import { RequestBodyError, readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import { type RemoteRegistry, remoteId } from "./registry.js";
import { RemoteError } from "./errors.js";
import type { RemoteHostKeyProbe } from "./host-key.js";
import type { RemoteTerminalSessions } from "./sessions.js";

export function remoteConnectionRoutes(
  registry: RemoteRegistry,
  sessions: RemoteTerminalSessions,
  probe: RemoteHostKeyProbe,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect =
    (handle: (context: RouteContext, actor: string) => Promise<void>): Route["handler"] =>
    async (context) => {
      const { req, res } = context;
      let actor: string;
      try {
        if (!sharedWorkspaceAllowed(req) || !matchesCookieMutationOrigin(req)) throw new RemoteError("denied");
        actor = owner(context);
      } catch {
        return respondJson(res, 403, { error: "remoteTools.denied" });
      }
      try {
        await handle(context, actor);
      } catch (error) {
        if (error instanceof RemoteError) {
          const code = error.code;
          const status =
            code === "conflict"
              ? 409
              : code === "notFound"
                ? 404
                : code === "limit"
                  ? 429
                  : code === "unavailable" || code === "hostKeyUnavailable"
                    ? 503
                    : 400;
          return respondJson(res, status, { error: `remoteTools.${code}` });
        }
        if (error instanceof RequestBodyError)
          return respondJson(res, error.status, { error: "remoteTools.invalidInput" });
        reportDiagnostic("remote-connections", error);
        respondJson(res, 503, { error: "remoteTools.unavailable" });
      }
    };
  return [
    {
      path: REMOTE_HOST_KEY_PATH,
      method: "POST",
      handler: protect(async ({ req, res, url }, actor) => {
        if (url.search) throw new RemoteError("invalidInput");
        const fingerprint = await probe.read(actor, await readJsonBody(req, 2048));
        respondJson(res, 200, fingerprint);
      }),
    },
    {
      path: REMOTE_CONNECTIONS_PATH,
      method: ["GET", "POST", "DELETE"],
      handler: protect(async ({ req, res, url }, actor) => {
        if (req.method === "GET") {
          if (!url.search) return respondJson(res, 200, { items: registry.list(actor) });
          if (url.searchParams.getAll("id").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "id"))
            throw new RemoteError("invalidInput");
          return respondJson(res, 200, { connection: registry.detail(actor, remoteId(url.searchParams.get("id"))) });
        }
        if (url.search) throw new RemoteError("invalidInput");
        const body = await readJsonBody(req, 48 * 1024);
        if (req.method === "DELETE") {
          if (Object.keys(body).some((key) => !["id", "version"].includes(key))) throw new RemoteError("invalidInput");
          const id = remoteId(body.id);
          registry.remove(actor, id, body.version);
          sessions.revoke(actor, id);
          return respondJson(res, 200, { removed: true });
        }
        const { connection, replayed } = await registry.save(actor, body);
        if (!replayed && connection.version > 1) sessions.revoke(actor, connection.id);
        respondJson(res, 200, { connection });
      }),
    },
  ];
}
