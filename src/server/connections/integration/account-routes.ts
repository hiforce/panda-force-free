import { matchesRequestOrigin } from "../../auth/origin.js";
import { DocumentError } from "../../documents/errors.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { Route, RouteContext } from "../../http/router.js";
import { errorPayload } from "../../i18n/error-payload.js";
import { readRequestBytes } from "../../request-bytes.js";
import { accountInput, accountUpdate } from "../accounts/input.js";
import type { SocialAccountService } from "../accounts/service.js";
import type { AwaitablePublicationStore } from "../async-ports.js";
import { CredentialError } from "../credentials/errors.js";
import { ConnectionError } from "../errors.js";
import { OAuthError } from "../oauth/errors.js";
import type { OAuthConsent } from "../oauth/service.js";
import { connectionId, connectionVersion } from "../validation.js";
import { sendConsentResult } from "./consent-page.js";
const callbackPath = "/api/publication-accounts/x/callback";
function callbackMatches(context: RouteContext, callback: string) {
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    throw new OAuthError("invalidCallback");
  }
  if (
    url.host.toLowerCase() !== context.req.headers.host?.toLowerCase() ||
    url.pathname !== callbackPath ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new OAuthError("invalidCallback");
}
function sameOrigin(context: RouteContext) {
  if (
    !matchesRequestOrigin({
      hostHeader: context.req.headers.host,
      origin: context.req.headers.origin,
      fetchSite: context.req.headers["sec-fetch-site"],
    })
  )
    throw new ConnectionError("identityRequired", 403);
}
function resultRedirect(context: RouteContext, id?: string) {
  context.res.writeHead(303, {
    location: "/api/publication-accounts/authorization-result" + (id ? "?id=" + encodeURIComponent(id) : ""),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  context.res.end();
}
export function accountRoutes(
  accounts: AwaitablePublicationStore<SocialAccountService>,
  consent: AwaitablePublicationStore<OAuthConsent>,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect =
    (handler: (context: RouteContext, actor: string) => void | Promise<void>): Route["handler"] =>
    async (context) => {
      try {
        if (context.req.method !== "GET") sameOrigin(context);
        await handler(context, owner(context));
      } catch (error) {
        if (error instanceof OAuthError)
          return respondJson(
            context.res,
            error.code === "authorizationRateLimited" ? 429 : error.code === "authorizationUnavailable" ? 503 : 409,
            errorPayload(`accounts.${error.code}`),
          );
        if (error instanceof ConnectionError)
          return respondJson(
            context.res,
            error.status,
            errorPayload(error.code === "targetChanged" ? "accounts.targetChanged" : `connections.${error.code}`),
          );
        if (error instanceof CredentialError)
          return respondJson(context.res, 409, errorPayload(`connections.${error.code}`));
        if (error instanceof RequestBodyError)
          return respondJson(context.res, error.status, errorPayload("connections.invalidInput"));
        if (error instanceof DocumentError)
          return respondJson(context.res, error.status, errorPayload("connections.notFound"));
        console.warn("[publication-accounts] Request could not be completed");
        respondJson(context.res, 503, errorPayload("accounts.authorizationUnavailable"));
      }
    };
  const id = (url: URL) => connectionId(url.searchParams.get("id"));
  return [
    {
      path: "/api/publication-accounts",
      method: ["GET", "POST"],
      handler: protect(async (context, actor) => {
        if (context.req.method === "GET")
          return respondJson(context.res, 200, {
            accounts: await accounts.list(actor, connectionId(context.url.searchParams.get("project"))),
          });
        const input = accountInput(await readJsonBody(context.req, 8192));
        callbackMatches(context, input.application.callbackUrl);
        respondJson(context.res, 201, { account: await accounts.create(actor, input) });
      }),
    },
    {
      path: "/api/publication-accounts/detail",
      method: ["GET", "PUT"],
      handler: protect(async (context, actor) => {
        if (context.req.method === "GET")
          return respondJson(context.res, 200, { account: await accounts.detail(actor, id(context.url)) });
        const input = accountUpdate(await readJsonBody(context.req, 8192));
        if (input.application) callbackMatches(context, input.application.callbackUrl);
        respondJson(context.res, 200, { account: await accounts.update(actor, id(context.url), input) });
      }),
    },
    {
      path: "/api/publication-accounts/authorize",
      method: "POST",
      handler: protect(async (context, actor) => {
        const input = await readJsonBody(context.req, 4096),
          current = await accounts.detail(actor, connectionId(input.id));
        if (current.version !== connectionVersion(input.version)) throw new ConnectionError("conflict", 409);
        callbackMatches(context, current.application.callbackUrl);
        respondJson(context.res, 201, { authorization: await consent.start(actor, current.id) });
      }),
    },
    {
      path: "/api/publication-accounts/authorization",
      method: "GET",
      handler: protect(async (context, actor) => {
        const authorization = await consent.status(actor, id(context.url));
        await accounts.detail(actor, authorization.connectionId);
        respondJson(context.res, 200, { authorization });
      }),
    },
    {
      path: "/api/publication-accounts/verify",
      method: "POST",
      handler: protect(async (context, actor) => {
        const input = await readJsonBody(context.req, 4096);
        respondJson(context.res, 200, { authorization: await consent.verify(actor, connectionId(input.id)) });
      }),
    },
    {
      path: "/api/publication-accounts/disconnect",
      method: "POST",
      handler: protect(async (context, actor) => {
        const input = await readJsonBody(context.req, 4096);
        respondJson(context.res, 200, {
          account: await accounts.disconnect(actor, connectionId(input.id), connectionVersion(input.version)),
        });
      }),
    },
    {
      path: "/api/publication-accounts/x/complete",
      method: "POST",
      handler: protect(async (context, actor) => {
        const input = await readJsonBody(context.req, 8192);
        if (
          Object.keys(input).some((key) => !["state", "code", "denied"].includes(key)) ||
          typeof input.state !== "string" ||
          typeof input.code !== "string" ||
          typeof input.denied !== "boolean"
        )
          throw new OAuthError("invalidOAuthInput");
        let attemptId: string | undefined;
        try {
          const state = input.state,
            authorization = await consent.stateStatus(actor, state);
          attemptId = authorization.id;
          callbackMatches(context, (await accounts.detail(actor, authorization.connectionId)).application.callbackUrl);
          if (input.denied) await consent.decline(actor, state);
          else await consent.callback(actor, state, input.code);
        } catch {
          /* The result page shows only durable state; raw provider errors never enter HTML or logs. */
        }
        respondJson(context.res, 200, {
          redirect:
            "/api/publication-accounts/authorization-result" +
            (attemptId ? "?id=" + encodeURIComponent(attemptId) : ""),
        });
      }),
    },
    {
      path: "/api/publication-accounts/authorization-result",
      method: "GET",
      handler: protect(async (context, actor) => {
        try {
          const result = await consent.status(actor, id(context.url)),
            connection = await accounts.detail(actor, result.connectionId);
          sendConsentResult(context, { ...result, projectId: connection.projectId });
        } catch {
          sendConsentResult(context, { phase: "failed" });
        }
      }),
    },
    {
      path: "/api/publication-accounts/verify-return",
      method: "POST",
      handler: protect(async (context, actor) => {
        const bytes = await readRequestBytes(context.req, 1024);
        const attemptId = connectionId(new URLSearchParams(bytes.toString("utf8")).get("id"));
        try {
          await consent.verify(actor, attemptId);
        } catch {
          /* Read-only retries retain durable status for the result page. */
        }
        resultRedirect(context, attemptId);
      }),
    },
  ];
}
