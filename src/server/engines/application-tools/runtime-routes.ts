import type { ApplicationRuntimePort } from "./runtime-port.js";
import type { Route, RouteContext } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { HarnessError } from "../../../shared/harness/contracts.js";

/** Read-only discovery does not send a prompt or alter active session preferences. */
export function applicationRuntimeRoutes(
  port: ApplicationRuntimePort,
  owner: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/model-catalog",
      method: ["GET"],
      async handler(context) {
        try {
          const id = context.url.searchParams.get("runtimeId"),
            conversation = context.url.searchParams.get("scope") === "conversation";
          if (id !== null && !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new HarnessError("invalidInput");
          respondJson(
            context.res,
            200,
            id
              ? { runtime: await port.discover(owner(context), id, conversation) }
              : await port.catalog(owner(context), conversation),
          );
        } catch (error) {
          const known = error instanceof HarnessError ? error : new HarnessError("unavailable", 503);
          respondJson(context.res, known.status, {
            error: `harness.error${known.code[0]!.toUpperCase()}${known.code.slice(1)}`,
            code: known.code,
          });
        }
      },
    },
  ];
}
