import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { respondJson } from "../../http/respond.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { DocumentError } from "../../documents/errors.js";
import { ConnectionError } from "../../connections/errors.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
export interface SearchApi {
  vectorStorage(c: RouteContext, connection: unknown): unknown;
  checkVectorStorage(c: RouteContext, input: unknown): unknown;
  previousSettings(c: RouteContext, project: unknown, source: unknown, offset: unknown): Promise<unknown>;
  catalog(c: RouteContext): unknown;
  query(c: RouteContext, p: unknown, test: boolean, s: AbortSignal): Promise<unknown>;
  status(c: RouteContext, project: unknown, source?: unknown): Promise<unknown>;
  audit(c: RouteContext, p: unknown): Promise<unknown>;
  configure(c: RouteContext, p: unknown): Promise<unknown>;
  retry(c: RouteContext, p: unknown): Promise<unknown>;
  preview(c: RouteContext, p: unknown): Promise<unknown>;
  manual(c: RouteContext, p: unknown): Promise<unknown>;
  saveSource(c: RouteContext, p: unknown): unknown;
  activate(c: RouteContext, p: unknown): Promise<unknown>;
  health(c: RouteContext, p: unknown): Promise<unknown>;
  addConnection(c: RouteContext, p: unknown): Promise<unknown>;
  addKnowledge(c: RouteContext, p: unknown): unknown;
  review(c: RouteContext, p: unknown, s: AbortSignal): Promise<unknown>;
  install(c: RouteContext, p: unknown): Promise<unknown>;
  export(c: RouteContext, ref: string): Promise<unknown>;
}
export function searchRoutes(api: SearchApi): Route[] {
  const route = (
    path: string,
    method: string,
    work: (c: RouteContext, p: Record<string, unknown>, s: AbortSignal) => unknown | Promise<unknown>,
  ): Route => ({
    path,
    method,
    handler: async (c) => {
      const controller = new AbortController(),
        abort = () => {
          if (!c.res.writableEnded) controller.abort();
        };
      c.req.once("aborted", abort);
      c.res.once("close", abort);
      try {
        if (
          method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: c.req.headers.host,
            origin: c.req.headers.origin,
            fetchSite: c.req.headers["sec-fetch-site"],
          })
        )
          throw new SearchError("forbidden", 403);
        const p =
          method === "GET" ? {} : await readJsonBody(c.req, path.endsWith("/review") ? 4 * 1024 * 1024 : 128 * 1024);
        const value = await work(c, p, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]));
        respondJson(c.res, 200, value, { "cache-control": "no-store" });
      } catch (error) {
        const known =
            error instanceof SearchError ||
            error instanceof DocumentError ||
            error instanceof RequestBodyError ||
            error instanceof ConnectionError,
          code =
            error instanceof SearchError
              ? error.code
              : error instanceof SourceError
                ? "invalidInput"
                : (error instanceof DocumentError || error instanceof ConnectionError) && error.status === 403
                  ? "forbidden"
                  : error instanceof DocumentError && error.status === 404
                    ? "notFound"
                    : error instanceof RequestBodyError || (error instanceof DocumentError && error.status === 400)
                      ? "invalidInput"
                      : "unavailable";
        respondJson(
          c.res,
          known ? error.status : error instanceof SourceError ? 400 : 503,
          { code, messageKey: "search." + code },
          { "cache-control": "no-store" },
        );
      } finally {
        c.req.removeListener("aborted", abort);
        c.res.removeListener("close", abort);
      }
    },
  });
  return [
    route("/api/search/vector-storage", "GET", (c) => {
      if (c.url.searchParams.size !== 1 || c.url.searchParams.getAll("connection").length !== 1)
        throw new SearchError("invalidInput");
      return api.vectorStorage(c, c.url.searchParams.get("connection"));
    }),
    route("/api/search/vector-storage/check", "POST", (c, p) => api.checkVectorStorage(c, p)),
    route("/api/search/catalog", "GET", (c) => api.catalog(c)),
    route("/api/search/previous-settings", "GET", (c) => {
      if (
        c.url.searchParams.size !== 3 ||
        ["project", "source", "offset"].some((k) => c.url.searchParams.getAll(k).length !== 1)
      )
        throw new SearchError("invalidInput");
      const offset = c.url.searchParams.get("offset")!;
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(offset)) throw new SearchError("invalidInput");
      return api.previousSettings(c, c.url.searchParams.get("project"), c.url.searchParams.get("source"), offset);
    }),
    route("/api/search/query", "POST", (c, p, s) => api.query(c, p, false, s)),
    route("/api/search/test", "POST", (c, p, s) => api.query(c, p, true, s)),
    route("/api/search/status", "GET", (c) =>
      api.status(c, c.url.searchParams.get("project"), c.url.searchParams.get("source") ?? undefined),
    ),
    route("/api/search/audit", "POST", (c, p) => api.audit(c, p)),
    route("/api/search/settings", "PUT", (c, p) => api.configure(c, p)),
    route("/api/search/rebuild", "POST", (c, p) => api.retry(c, p)),
    route("/api/search/preview", "POST", (c, p) => api.preview(c, p)),
    route("/api/search/knowledge", "POST", (c, p) => api.manual(c, p)),
    route("/api/search/sources", "PUT", (c, p) => api.saveSource(c, p)),
    route("/api/search/activate", "POST", (c, p) => api.activate(c, p)),
    route("/api/search/health", "POST", (c, p) => api.health(c, p)),
    route("/api/search/connections", "POST", (c, p) => api.addConnection(c, p)),
    route("/api/search/knowledge-profiles", "POST", (c, p) => api.addKnowledge(c, p)),
    route("/api/search/analyzers/review", "POST", (c, p, s) => api.review(c, p, s)),
    route("/api/search/analyzers/install", "POST", (c, p) => api.install(c, p)),
    route("/api/search/analyzers/export", "GET", (c) => api.export(c, c.url.searchParams.get("reference") || "")),
  ];
}
