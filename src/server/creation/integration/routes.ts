import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { CreationService } from "../service.js";
import { CreationError } from "../contracts.js";
import { creationRecord, creationText } from "../validation.js";
import { creationProtection } from "./protect.js";

export function creationRoutes(
  service: Pick<CreationService, "options" | "list" | "detail" | "submit" | "cancel" | "retry" | "answer" | "followUp">,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = creationProtection(owner),
    query = (url: URL, key: string) => {
      if ([...url.searchParams.keys()].some((name) => name !== key) || url.searchParams.getAll(key).length !== 1)
        throw new CreationError("invalidInput");
      return creationText(url.searchParams.get(key));
    };
  return [
    {
      path: "/api/document-creations/options",
      method: "GET",
      handler: protect(async ({ url, res }) => {
        if (url.search) throw new CreationError("invalidInput");
        respondJson(res, 200, await service.options());
      }),
    },
    {
      path: "/api/document-creations",
      method: ["GET", "POST"],
      handler: protect(async ({ req, url, res }, actor) => {
        if (req.method === "GET")
          return respondJson(res, 200, { tasks: await service.list(actor, query(url, "project")) });
        if (url.search) throw new CreationError("invalidInput");
        respondJson(res, 202, { task: await service.submit(actor, await readJsonBody(req, 2 * 1024 * 1024)) });
      }),
    },
    {
      path: "/api/document-creations/follow-up",
      method: "POST",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search) throw new CreationError("invalidInput");
        const input = creationRecord(await readJsonBody(req, 128 * 1024), ["taskId", "id", "prompt"]);
        respondJson(res, 202, {
          task: await service.followUp(actor, creationText(input.taskId), { id: input.id, prompt: input.prompt }),
        });
      }),
    },
    {
      path: "/api/document-creations/detail",
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        if (
          [...url.searchParams.keys()].some((key) => !["id", "view"].includes(key)) ||
          url.searchParams.getAll("id").length !== 1 ||
          url.searchParams.getAll("view").length > 1 ||
          (url.searchParams.has("view") && url.searchParams.get("view") !== "progress")
        )
          throw new CreationError("invalidInput");
        const started = performance.now(),
          task = await service.detail(
            actor,
            creationText(url.searchParams.get("id")),
            url.searchParams.get("view") !== "progress",
          );
        res.setHeader("server-timing", `creation-read;dur=${(performance.now() - started).toFixed(1)}`);
        respondJson(res, 200, { task });
      }),
    },
    ...["cancel", "retry", "answer"].map((action): Route => ({
      path: "/api/document-creations/" + action,
      method: "POST",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search) throw new CreationError("invalidInput");
        const input = creationRecord(
            await readJsonBody(req, 128 * 1024),
            action === "retry" ? ["id", "operationId"] : action === "answer" ? ["id", "answers"] : ["id"],
          ),
          id = creationText(input.id);
        const task =
          action === "retry"
            ? await service.retry(actor, id, creationText(input.operationId))
            : action === "answer"
              ? await service.answer(actor, id, { answers: input.answers })
              : await service.cancel(actor, id);
        respondJson(res, 200, { task });
      }),
    })),
  ];
}
