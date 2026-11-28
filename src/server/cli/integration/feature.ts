import { pandaCliManual } from "../../../shared/cli/manual.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import { createRouter } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { CliCredentials } from "../auth/service.js";
import { openCliCredentialStore } from "../auth/sqlite.js";
import { cliApiRoute, cliRegistrationRoutes } from "./http.js";
import type { CliContentCommands } from "../commands.js";
import { cliContentError } from "./errors.js";
import type { CliCredentialStore } from "../auth/ports.js";
import { installLocalCli } from "./local-install.js";
export function createCliFeature(options: {
  stateRoot: string;
  commands: CliContentCommands;
  owner(context: RouteContext): string;
  authorize(owner: string, project: string): Promise<void>;
  report(error: unknown): void;
  database?: { store: CliCredentialStore; close(): void | Promise<void> };
}) {
  try {
    const database = options.database ?? openCliCredentialStore(join(options.stateRoot, "data", "cli-auth.sqlite")),
      credentials = new CliCredentials(database.store),
      dispatch = createRouter([cliApiRoute(credentials, options.commands)]);
    let closing = false,
      active = 0,
      drain: (() => void) | null = null,
      closePromise: Promise<void> | null = null;
    let localInstall: Promise<void> | undefined;
    const tracked = async (context: RouteContext, run: () => Promise<void>) => {
      if (closing) {
        respondJson(
          context.res,
          503,
          { schema: 1, error: { code: "unavailable" } },
          { "cache-control": "no-store", connection: "close" },
        );
        return;
      }
      active++;
      try {
        await run();
      } finally {
        active--;
        if (!active) drain?.();
      }
    };
    return {
      provisionLocal(owner: string, loopback: string) {
        if (closing) return Promise.resolve();
        return (localInstall ??= installLocalCli(
          credentials,
          join(options.stateRoot, "local-cli"),
          loopback,
          owner,
          (project) => options.authorize(owner, project),
        )
          .catch(options.report)
          .finally(() => {
            localInstall = undefined;
          }));
      },
      routes: [
        ...cliRegistrationRoutes(credentials, {
          ...options,
          authorize: async (owner, project) => {
            try {
              await options.authorize(owner, project);
            } catch (error) {
              throw cliContentError(error);
            }
          },
        }),
        {
          path: "/api/cli/manual",
          method: "GET",
          handler: ({ res }: RouteContext) => {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            });
            res.end(pandaCliManual());
          },
        },
      ].map((route) => ({
        ...route,
        handler: (context: RouteContext) =>
          tracked(context, async () => {
            await route.handler(context);
          }),
      })),
      async handle(context: RouteContext) {
        if (!(context.url.pathname === "/api/cli/v1" || context.url.pathname.startsWith("/api/cli/v1/"))) return false;
        await tracked(context, async () => {
          await dispatch(context);
        });
        return true;
      },
      close: () =>
        (closePromise ??= (async () => {
          closing = true;
          await localInstall;
          if (active)
            await new Promise<void>((resolve) => {
              drain = resolve;
            });
          await database.close();
        })()),
    };
  } catch (error) {
    options.report(error);
    return {
      routes: [],
      async provisionLocal() {},
      async handle(context: RouteContext) {
        if (!(context.url.pathname === "/api/cli/v1" || context.url.pathname.startsWith("/api/cli/v1/"))) return false;
        respondJson(context.res, 503, { schema: 1, error: { code: "unavailable" } }, { "cache-control": "no-store" });
        return true;
      },
      async close() {},
    };
  }
}
