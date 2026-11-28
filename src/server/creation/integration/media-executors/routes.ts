import type { ServerResponse } from "node:http";
import type { Route, RouteContext } from "../../../http/router.js";
import { readJsonBody } from "../../../http/body.js";
import { respondJson } from "../../../http/respond.js";
import { CreationError } from "../../contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../../validation.js";
import { localRequestIdentity } from "../../../auth/users/identity.js";
import { MediaExecutorError } from "../../media-executors/contracts.js";
import type { CreationMediaExecutorPort } from "../../media-executors/contracts.js";

const errorStatus: Partial<Record<MediaExecutorError["code"], number>> = {
  invalidInput: 400,
  notFound: 404,
  conflict: 409,
  authentication: 422,
  rateLimited: 429,
};

function respondMediaError(res: ServerResponse, error: unknown) {
  const code =
    error instanceof MediaExecutorError
      ? error.code
      : error instanceof CreationError && error.code === "invalidInput"
        ? "invalidInput"
        : "unavailable";
  respondJson(res, errorStatus[code] ?? 503, { code });
}

export function creationMediaExecutorRoutes(
  service: CreationMediaExecutorPort | undefined,
  owner: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/personal/creation-media-cli",
      method: ["GET", "POST"],
      async handler({ req, res, url }) {
        res.setHeader("Cache-Control", "no-store");
        if (localRequestIdentity(req)?.role !== "admin") return respondJson(res, 403, { code: "forbidden" });
        try {
          if (req.method === "GET") {
            if (!url.search)
              return respondJson(res, 200, { configured: !!service, packages: (await service?.cliCatalog()) ?? [] });
            if (!service) throw new MediaExecutorError("unavailable");
            const id = creationText(url.searchParams.get("id"), 64);
            const revision = url.searchParams.get("revision");
            if (url.searchParams.size !== 2 || !revision || !/^\d+$/.test(revision))
              throw new MediaExecutorError("invalidInput");
            return respondJson(res, 200, await service.cliInstructions(id, creationInteger(Number(revision))));
          }
          if (url.search) throw new MediaExecutorError("invalidInput");
          if (!service) throw new MediaExecutorError("unavailable");
          const row = creationRecord(await readJsonBody(req, 2048), ["id", "revision", "fingerprint"]);
          await service.registerCli(
            creationText(row.id, 64),
            creationInteger(row.revision),
            creationDigest(row.fingerprint),
            AbortSignal.timeout(15000),
          );
          respondJson(res, 200, { registered: true });
        } catch (error) {
          respondMediaError(res, error);
        }
      },
    },
    {
      path: "/api/personal/creation-media-credentials",
      method: ["POST", "DELETE"],
      async handler(context) {
        const { req, res, url } = context;
        res.setHeader("Cache-Control", "no-store");
        try {
          if (url.search) throw new MediaExecutorError("invalidInput");
          if (!service) throw new MediaExecutorError("unavailable");
          const actor = owner(context);
          const input = await readJsonBody(req, 16384);
          if (req.method === "POST") return respondJson(res, 200, await service.saveCredential(actor, input));
          const row = creationRecord(input, ["id", "revision"]);
          await service.removeCredential(actor, creationUuid(row.id), creationInteger(row.revision));
          respondJson(res, 200, { removed: true });
        } catch (error) {
          respondMediaError(res, error);
        }
      },
    },
    {
      path: "/api/personal/creation-media-executors",
      method: ["GET", "POST", "DELETE"],
      async handler(context) {
        const { req, res, url } = context;
        res.setHeader("Cache-Control", "no-store");
        try {
          if (url.search) throw new MediaExecutorError("invalidInput");
          const actor = owner(context);
          if (!service) {
            if (req.method === "GET")
              return respondJson(res, 200, { configured: false, presets: [], executors: [], credentials: [] });
            throw new MediaExecutorError("unavailable");
          }
          if (req.method === "GET") return respondJson(res, 200, await service.list(actor));
          const input = await readJsonBody(req, 16384);
          if (req.method === "POST") return respondJson(res, 200, await service.save(actor, input));
          const row = creationRecord(input, ["id", "revision"]);
          await service.remove(actor, creationUuid(row.id), creationInteger(row.revision));
          respondJson(res, 200, { removed: true });
        } catch (error) {
          respondMediaError(res, error);
        }
      },
    },
  ];
}
