import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { CreationService } from "../service.js";
import { CreationError } from "../contracts.js";
import { creationRecord, creationText } from "../validation.js";
import { creationProtection } from "./protect.js";

export function creationRoutes(
  service: Pick<
    CreationService,
    "options" | "list" | "detail" | "submit" | "cancel" | "retry" | "answer" | "followUp"
  > &
    Partial<Pick<CreationService, "message" | "goal" | "clearHistory" | "rounds">>,
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
      path: "/api/document-creations/rounds",
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        if (
          !service.rounds ||
          [...url.searchParams.keys()].some((key) => !["id", "cursor"].includes(key)) ||
          url.searchParams.getAll("id").length !== 1 ||
          url.searchParams.getAll("cursor").length > 1
        )
          throw new CreationError("invalidInput");
        respondJson(
          res,
          200,
          await service.rounds(
            actor,
            creationText(url.searchParams.get("id")),
            url.searchParams.has("cursor") ? creationText(url.searchParams.get("cursor"), 128) : undefined,
          ),
        );
      }),
    },
    {
      path: "/api/document-creations/history/clear",
      method: "POST",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search || !service.clearHistory) throw new CreationError("unavailable");
        respondJson(res, 200, await service.clearHistory(actor, await readJsonBody(req, 4096)));
      }),
    },
    {
      path: "/api/document-creations/goal",
      method: "POST",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search || !service.goal) throw new CreationError("unavailable");
        const value = creationRecord(await readJsonBody(req, 96 * 1024), [
          "taskId",
          "id",
          "action",
          "objective",
          "model",
          "effort",
        ]);
        const { taskId, ...command } = value;
        respondJson(res, 200, await service.goal(actor, creationText(taskId), command));
      }),
    },
    {
      path: "/api/document-creations/message",
      method: "POST",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search || !service.message) throw new CreationError("unavailable");
        const value = creationRecord(await readJsonBody(req, 128 * 1024), [
          "taskId",
          "id",
          "prompt",
          "selections",
          "attachments",
          "outputType",
          "model",
          "effort",
        ]);
        const { taskId, ...input } = value;
        respondJson(res, 202, { task: await service.message(actor, creationText(taskId), input) });
      }),
    },
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
        if (req.method === "GET") {
          const tasks = await service.list(actor, query(url, "project"));
          return respondJson(res, 200, { tasks, before: Date.now() + 1 });
        }
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
