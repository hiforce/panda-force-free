import type { AwaitableStore } from "../../../shared/async-store.js";
import { RemoteFileError } from "../../../shared/connections/remote-files.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { SiteBuildError } from "../../builds/errors.js";
import type { SftpHostTrust } from "../../connections/adapters/sftp-trust.js";
import { CredentialError } from "../../connections/credentials/errors.js";
import { ConnectionError } from "../../connections/errors.js";
import type { ConnectionSecretService } from "../../connections/secret-service.js";
import type { ConnectionService } from "../../connections/service.js";
import { connectionId, connectionVersion } from "../../connections/validation.js";
import { DocumentError } from "../../documents/errors.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { Route, RouteContext } from "../../http/router.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { DeliveryError } from "../errors.js";
import type { PublicationService } from "../service.js";
export function publicationRoutes(
  connections: AwaitableStore<ConnectionService>,
  credentials: AwaitableStore<ConnectionSecretService>,
  trust: AwaitableStore<SftpHostTrust>,
  publications: AwaitableStore<PublicationService>,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect =
    (handler: (context: RouteContext, ownerId: string) => Promise<void> | void): Route["handler"] =>
    async (context) => {
      try {
        if (
          context.req.method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: context.req.headers.host,
            origin: context.req.headers.origin,
            fetchSite: context.req.headers["sec-fetch-site"],
          })
        )
          throw new DeliveryError("crossOrigin", 403);
        await handler(context, owner(context));
      } catch (error) {
        if (error instanceof CredentialError || error instanceof RemoteFileError)
          return respondJson(
            context.res,
            409,
            errorPayload(
              `connections.${error instanceof RemoteFileError && error.code === "notFound" ? "notFoundRemote" : error.code}`,
            ),
          );
        if (error instanceof ConnectionError || error instanceof DeliveryError)
          return respondJson(
            context.res,
            error.status,
            errorPayload(`${error instanceof ConnectionError ? "connections" : "delivery"}.${error.code}`),
          );
        if (error instanceof DocumentError || error instanceof SiteBuildError)
          return respondJson(
            context.res,
            error.status,
            errorPayload(error.status === 404 ? "delivery.notFound" : "delivery.sourceUnavailable"),
          );
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("delivery.invalidInput"));
        // Adapter error objects may contain remote endpoints or secrets. API diagnostics use stable categories only.
        console.warn("[publication] Request could not be completed");
        respondJson(context.res, 503, errorPayload("delivery.unavailable"));
      }
    };
  const id = (url: URL) => connectionId(url.searchParams.get("id"));
  return [
    {
      path: "/api/publication-connections/roots",
      method: "GET",
      handler: protect(async ({ res }) => respondJson(res, 200, { roots: await connections.roots() })),
    },
    {
      path: "/api/publication-connections",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }, actor) => {
        if (req.method === "GET")
          return respondJson(res, 200, {
            connections: await connections.list(actor, connectionId(url.searchParams.get("project"))),
          });
        respondJson(res, 201, { connection: await connections.create(actor, await readJsonBody(req, 8192)) });
      }),
    },
    {
      path: "/api/publication-connections/detail",
      method: ["GET", "PUT"],
      handler: protect(async ({ req, res, url }, actor) => {
        const connection =
          req.method === "GET"
            ? (await connections.owned(actor, id(url))).connection
            : await connections.update(actor, id(url), await readJsonBody(req, 4096));
        respondJson(res, 200, { connection });
      }),
    },
    {
      path: "/api/publication-connections/credentials",
      method: "PUT",
      handler: protect(async ({ req, res, url }, actor) =>
        respondJson(res, 200, {
          connection: await credentials.write(actor, id(url), await readJsonBody(req, 64 * 1024)),
        }),
      ),
    },
    {
      path: "/api/publication-connections/trust",
      method: "PUT",
      handler: protect(async ({ req, res, url }, actor) =>
        respondJson(res, 200, { connection: await trust.replace(actor, id(url), await readJsonBody(req, 4096)) }),
      ),
    },
    {
      path: "/api/publication-connections/test",
      method: "POST",
      handler: protect(async ({ req, res, url }, actor) =>
        respondJson(
          res,
          200,
          await connections.test(actor, id(url), connectionVersion((await readJsonBody(req, 4096)).version)),
        ),
      ),
    },
    {
      path: "/api/site-publications",
      method: ["GET", "POST"],
      handler: protect(async ({ req, res, url }, actor) => {
        if (req.method === "GET")
          return respondJson(res, 200, {
            publications: await publications.list(
              actor,
              connectionId(url.searchParams.get("space")),
              url.searchParams.has("project") ? connectionId(url.searchParams.get("project")) : undefined,
            ),
          });
        respondJson(res, 201, { publication: await publications.prepare(actor, await readJsonBody(req, 4096)) });
      }),
    },
    {
      path: "/api/site-publications/detail",
      method: "GET",
      handler: protect(async ({ res, url }, actor) =>
        respondJson(res, 200, { publication: await publications.detail(actor, id(url)) }),
      ),
    },
    {
      path: "/api/site-publications/publish",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = await readJsonBody(req, 4096);
        if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint))
          throw new DeliveryError("invalidInput");
        respondJson(res, 202, {
          publication: await publications.publish(actor, connectionId(input.id), input.fingerprint),
        });
      }),
    },
    {
      path: "/api/site-publications/reconcile",
      method: "POST",
      handler: protect(async ({ req, res }, actor) =>
        respondJson(res, 202, {
          publication: await publications.reconcile(actor, connectionId((await readJsonBody(req, 4096)).id)),
        }),
      ),
    },
    {
      path: "/api/site-publications/recover",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = await readJsonBody(req, 4096);
        if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint))
          throw new DeliveryError("invalidInput");
        respondJson(res, 202, {
          publication: await publications.recover(actor, connectionId(input.id), input.fingerprint),
        });
      }),
    },
    {
      path: "/api/site-publications/cancel",
      method: "POST",
      handler: protect(async ({ req, res }, actor) =>
        respondJson(res, 200, {
          publication: await publications.cancel(actor, connectionId((await readJsonBody(req, 4096)).id)),
        }),
      ),
    },
  ];
}
