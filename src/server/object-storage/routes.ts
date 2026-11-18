import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { matchesCookieMutationOrigin } from "../auth/origin.js";
import { originalStorageErrorMessages } from "../../shared/storage/messages.js";
import { ObjectStorageError } from "./contracts.js";
import type { OriginalStorageConfiguration } from "./configuration.js";

const root = "/api/system/storage";
const ownedHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
/** Installation administration and login authentication are independent of a user's project access. */
export function originalStorageRoutes(options: {
  configuration: OriginalStorageConfiguration;
  administrator(context: RouteContext): boolean;
  authenticationConfigured(): boolean;
}): Route[] {
  const failure = (context: RouteContext, cause: unknown) => {
    const error =
        cause instanceof ObjectStorageError
          ? cause
          : cause instanceof RequestBodyError
            ? new ObjectStorageError(
                cause.status === 413 ? "storageTooLarge" : "storageInvalidConfiguration",
                false,
                cause.status,
              )
            : new ObjectStorageError("storageUnavailable", true),
      status =
        error.status ??
        {
          storageInvalidConfiguration: 400,
          storageAdministratorRequired: 403,
          storageAuthenticationRequired: 403,
          storageDenied: 403,
          storageConflict: 409,
          storageTooLarge: 413,
          storageIntegrity: 503,
          storageUnavailable: 503,
        }[error.code];
    respondJson(
      context.res,
      status,
      { error: { code: error.code, messageId: originalStorageErrorMessages[error.code], retryable: error.retryable } },
      ownedHeaders,
    );
  };
  return [
    {
      path: (path) => path === root || path.startsWith(root + "/"),
      method: ["GET", "POST"],
      handler: async (context) => {
        try {
          if (!options.authenticationConfigured()) throw new ObjectStorageError("storageAuthenticationRequired");
          if (!options.administrator(context)) throw new ObjectStorageError("storageAdministratorRequired");
          if (context.req.method === "GET") {
            if (context.url.pathname === root)
              return respondJson(context.res, 200, await options.configuration.read(), ownedHeaders);
            const operation = /^\/api\/system\/storage\/operations\/([a-f0-9-]{36})$/.exec(context.url.pathname);
            if (operation)
              return respondJson(context.res, 200, await options.configuration.operation(operation[1]!), ownedHeaders);
            throw new ObjectStorageError("storageInvalidConfiguration", false, 404);
          }
          if (!matchesCookieMutationOrigin(context.req)) throw new ObjectStorageError("storageAdministratorRequired");
          if (context.url.pathname !== root) throw new ObjectStorageError("storageInvalidConfiguration", false, 404);
          respondJson(
            context.res,
            200,
            await options.configuration.save(await readJsonBody(context.req, 65536)),
            ownedHeaders,
          );
        } catch (error) {
          failure(context, error);
        }
      },
    },
  ];
}
