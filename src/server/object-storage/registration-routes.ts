import {
  googleStorageCompletePath,
  storageConnectionsPath,
  storageToolsPath,
} from "../../shared/workspace-tools/storage.js";
import type { MessageId } from "../../shared/i18n/messages.js";
import { matchesCookieMutationOrigin } from "../auth/origin.js";
import { passwordSessionToken } from "../auth/security.js";
import { readJsonBody, RequestBodyError } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import { ObjectStorageError } from "./contracts.js";
import { type GoogleStorageConsent } from "./google-consent.js";
import { type StorageRegistration } from "./registration.js";

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
function failure(context: RouteContext, status: number, messageId: MessageId) {
  respondJson(context.res, status, { error: { messageId } }, headers);
}
function googleResult(context: RouteContext, result: string) {
  respondJson(context.res, 200, { redirect: storageToolsPath + "?google=" + encodeURIComponent(result) }, headers);
}
export function storageRegistrationRoutes(options: {
  storage: StorageRegistration;
  google: GoogleStorageConsent;
  authenticationConfigured(): boolean;
  administrator(context: RouteContext): boolean;
}): Route[] {
  return [
    {
      path: storageConnectionsPath,
      method: ["GET", "POST"],
      async handler(context) {
        if (!options.authenticationConfigured() || !options.administrator(context))
          return failure(context, 403, "storageConnections.administrator");
        if (context.req.method === "POST" && !matchesCookieMutationOrigin(context.req))
          return failure(context, 403, "storageConnections.administrator");
        try {
          if (context.req.method === "GET")
            return respondJson(context.res, 200, { connections: await options.storage.list() }, headers);
          const input = await readJsonBody(context.req, 32768);
          if (input?.action === "rotate") {
            await options.storage.rotateObject(input);
            return respondJson(context.res, 200, { saved: true }, headers);
          }
          if (input?.provider === "google-drive") {
            const session = passwordSessionToken(context.req),
              origin = context.req.headers.origin;
            if (!session || !origin) return failure(context, 403, "storageConnections.administrator");
            const authorizationUrl = await options.google.begin(input, origin, session);
            return respondJson(context.res, 200, { authorizationUrl }, headers);
          }
          const connection = await options.storage.addObjectStorage(input);
          respondJson(context.res, 200, { connection }, headers);
        } catch (error) {
          if (error instanceof RequestBodyError) return failure(context, error.status, "storageConnections.invalid");
          if (error instanceof ObjectStorageError) {
            if (error.code === "storageInvalidConfiguration")
              return failure(context, 400, "storageConnections.invalid");
            if (error.code === "storageConflict") return failure(context, 409, "storageConnections.conflict");
          }
          failure(context, 503, "storageConnections.unavailable");
        }
      },
    },
    {
      path: googleStorageCompletePath,
      method: ["POST"],
      async handler(context) {
        const session = passwordSessionToken(context.req);
        if (
          !session ||
          !options.authenticationConfigured() ||
          !options.administrator(context) ||
          !matchesCookieMutationOrigin(context.req)
        )
          return failure(context, 403, "storageConnections.administrator");
        try {
          const input = await readJsonBody(context.req, 16384);
          if (typeof input?.state !== "string" || typeof input.code !== "string" || typeof input.denied !== "boolean")
            return failure(context, 400, "storageConnections.invalid");
          const query = new URLSearchParams({ state: input.state, code: input.code });
          if (input.denied) query.set("error", "access_denied");
          googleResult(context, await options.google.finish(query, context.req.headers.host, session));
        } catch {
          googleResult(context, "failed");
        }
      },
    },
  ];
}
