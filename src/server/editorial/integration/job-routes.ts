import type { Route } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { EditorialJobs } from "../jobs/service.js";
import type { EditorialModel } from "../model/contracts.js";
import { EditorialError } from "../errors.js";
import { editorialField as field, editorialOwner as owner, protectEditorial as protect } from "./protect.js";

export function editorialJobRoutes(
  jobs: Pick<EditorialJobs, "submit" | "detail" | "list" | "cancel" | "retry">,
  models: ReadonlyMap<string, EditorialModel>,
  wake: () => void,
  configurationInvalid = false,
): Route[] {
  return [
    {
      path: "/api/document-editorial/processors",
      method: "GET",
      handler: protect((context) => {
        owner(context);
        respondJson(context.res, 200, {
          profiles: [...models.values()].map((model) => model.profile),
          configurationInvalid,
        });
      }),
    },
    {
      path: "/api/document-editorial/jobs",
      method: ["GET", "POST"],
      handler: protect(async (context) => {
        const actor = owner(context);
        if (context.req.method === "GET")
          return respondJson(context.res, 200, {
            jobs: await jobs.list(
              actor,
              field(context.url.searchParams.get("document")),
              context.url.searchParams.get("project") ?? undefined,
            ),
          });
        const job = await jobs.submit(actor, await readJsonBody(context.req, 8192));
        wake();
        respondJson(context.res, 202, { job });
      }),
    },
    {
      path: "/api/document-editorial/jobs/detail",
      method: "GET",
      handler: protect(async (context) =>
        respondJson(context.res, 200, {
          job: await jobs.detail(owner(context), field(context.url.searchParams.get("id"))),
        }),
      ),
    },
    {
      path: "/api/document-editorial/jobs/action",
      method: "POST",
      handler: protect(async (context) => {
        const input = await readJsonBody(context.req, 8192),
          actor = owner(context),
          id = field(input.id);
        if (Object.keys(input).some((key) => !["id", "action", "retryId"].includes(key)))
          throw new EditorialError("invalidInput");
        if (input.action !== "cancel" && input.action !== "retry") throw new EditorialError("invalidInput");
        const job =
          input.action === "cancel" ? await jobs.cancel(actor, id) : await jobs.retry(actor, id, field(input.retryId));
        wake();
        respondJson(context.res, 200, { job });
      }),
    },
  ];
}
