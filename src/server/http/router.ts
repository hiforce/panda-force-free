import type { IncomingMessage, ServerResponse } from "node:http";
import { respondMethodNotAllowed } from "./respond.js";

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Present when IDAAS authentication produced a session for this request. */
  idaasSession?: { id: string; identity: any; expiresAt: number } | null;
};

export type Route = {
  /** Exact pathname(s) or a predicate for prefix matches. */
  path: string | string[] | ((pathname: string) => boolean);
  /** Allowed method(s); omit to accept any method (legacy behavior of some endpoints). */
  method?: string | string[];
  handler: (ctx: RouteContext) => void | Promise<void>;
};

/**
 * Declarative route table. Returns a dispatcher that answers whether the
 * request was handled; method mismatches get a uniform 405 with Allow.
 */
export function createRouter(routes: Route[]) {
  return async function dispatch(ctx: RouteContext): Promise<boolean> {
    const { pathname } = ctx.url;
    for (const route of routes) {
      const matched =
        typeof route.path === "function"
          ? route.path(pathname)
          : Array.isArray(route.path)
            ? route.path.includes(pathname)
            : route.path === pathname;
      if (!matched) continue;
      if (route.method) {
        const allowed = Array.isArray(route.method) ? route.method : [route.method];
        if (!allowed.includes(ctx.req.method || "")) {
          respondMethodNotAllowed(ctx.res, allowed.join(", "));
          return true;
        }
      }
      await route.handler(ctx);
      return true;
    }
    return false;
  };
}
