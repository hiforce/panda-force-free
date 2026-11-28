import { harnessCreationCapabilities } from "../../harness/creation-capabilities.js";
import type { HarnessRuntimeView } from "../../../shared/harness/contracts.js";
import type { HarnessCreationCapabilities } from "../../../shared/creation/media-executors.js";
import type { ApplicationRuntimePort } from "./runtime-port.js";
import type { Route, RouteContext } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { HarnessError } from "../../../shared/harness/contracts.js";

/** Read-only discovery does not send a prompt or alter active session preferences. */
export function applicationRuntimeRoutes(
  port: ApplicationRuntimePort,
  owner: (context: RouteContext) => string,
  capabilities?: (owner: string, runtime: HarnessRuntimeView) => Promise<HarnessCreationCapabilities>,
): Route[] {
  return [
    {
      path: "/api/model-catalog",
      method: ["GET"],
      async handler(context) {
        try {
          const id = context.url.searchParams.get("runtimeId"),
            scope = context.url.searchParams.get("scope"),
            catalogScope =
              scope === "bots" || scope === "creation" || scope === "project-memory" ? scope : scope === "conversation";
          if (id !== null && !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new HarnessError("invalidInput");
          const actor = owner(context);
          const forCreation = async (runtime: HarnessRuntimeView) =>
            catalogScope === "creation"
              ? {
                  ...runtime,
                  creationCapabilities: await (capabilities?.(actor, runtime) ?? harnessCreationCapabilities(runtime)),
                }
              : runtime;
          if (id) {
            respondJson(context.res, 200, { runtime: await forCreation(await port.discover(actor, id, catalogScope)) });
          } else {
            const catalog = await port.catalog(actor, catalogScope);
            respondJson(context.res, 200, {
              ...catalog,
              runtimes: await Promise.all(catalog.runtimes.map(forCreation)),
            });
          }
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
