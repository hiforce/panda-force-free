import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { knowledgeId, knowledgeObject } from "../../../shared/knowledge/task-validation.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import type { KnowledgeTasks } from "../tasks/service.js";
import type { KnowledgeReviewSettings } from "../review/service.js";
import { knowledgeHttp } from "./http.js";

export function knowledgeRoutes(
  service: Pick<
    KnowledgeTasks,
    | "submit"
    | "list"
    | "history"
    | "detail"
    | "previous"
    | "status"
    | "answer"
    | "edit"
    | "approve"
    | "cancel"
    | "retry"
  >,
  options: {
    owner(context: RouteContext): string;
    available(): boolean;
    report(error: unknown): void;
    review?: Pick<KnowledgeReviewSettings, "policy" | "configure" | "detail">;
  },
): Route[] {
  const { protect, query } = knowledgeHttp(options);
  return [
    {
      path: "/api/knowledge/options",
      method: "GET",
      handler: protect(async ({ url, res }) => {
        if (url.search) throw new KnowledgeTaskError("invalidInput");
        respondJson(res, 200, {
          available: options.available(),
          maxSources: 32,
          reviewRequired: true,
          automaticReviewAvailable: !!options.review,
        });
      }),
    },
    {
      path: "/api/knowledge/review-policy",
      method: ["GET", "PUT"],
      handler: protect(async ({ req, url, res }, owner) => {
        if (!options.review) throw new KnowledgeTaskError("unavailable");
        if (req.method === "GET")
          return respondJson(res, 200, { policy: await options.review.policy(owner, query(url, "project")) });
        if (url.search) throw new KnowledgeTaskError("invalidInput");
        const p = knowledgeObject(await readJsonBody(req, 4096), ["project", "automatic", "revision"]);
        respondJson(res, 200, {
          policy: await options.review.configure(owner, knowledgeId(p.project), {
            automatic: p.automatic,
            revision: p.revision,
          }),
        });
      }),
    },
    {
      path: "/api/knowledge/tasks/review",
      method: "GET",
      handler: protect(async ({ url, res }, owner) => {
        if (!options.review) throw new KnowledgeTaskError("unavailable");
        respondJson(res, 200, await options.review.detail(owner, query(url, "id")));
      }),
    },
    {
      path: "/api/knowledge/tasks",
      method: ["GET", "POST"],
      handler: protect(async ({ req, url, res }, owner) => {
        if (req.method === "GET") {
          if (
            [...url.searchParams.keys()].some((key) => !["project", "cursor"].includes(key)) ||
            url.searchParams.getAll("project").length !== 1 ||
            url.searchParams.getAll("cursor").length > 1
          )
            throw new KnowledgeTaskError("invalidInput");
          return respondJson(
            res,
            200,
            await service.history(
              owner,
              knowledgeId(url.searchParams.get("project")),
              url.searchParams.get("cursor") ?? undefined,
            ),
          );
        }
        if (url.search || !options.available()) throw new KnowledgeTaskError("unavailable");
        respondJson(res, 202, { task: await service.submit(owner, await readJsonBody(req, 16 * 1024)) });
      }),
    },
    {
      path: "/api/knowledge/tasks/status",
      method: "GET",
      handler: protect(async ({ url, res }, owner) => {
        respondJson(res, 200, { task: await service.status(owner, query(url, "id")) });
      }),
    },
    {
      path: "/api/knowledge/tasks/detail",
      method: "GET",
      handler: protect(async ({ url, res }, owner) => {
        respondJson(res, 200, await service.detail(owner, query(url, "id")));
      }),
    },
    {
      path: "/api/knowledge/tasks/previous",
      method: "GET",
      handler: protect(async ({ url, res }, owner) => {
        if (
          [...url.searchParams.keys()].some((key) => !["id", "offset"].includes(key)) ||
          url.searchParams.getAll("id").length !== 1 ||
          url.searchParams.getAll("offset").length > 1
        )
          throw new KnowledgeTaskError("invalidInput");
        const offset = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,8}$/.test(offset)) throw new KnowledgeTaskError("invalidInput");
        respondJson(res, 200, await service.previous(owner, knowledgeId(url.searchParams.get("id")), Number(offset)));
      }),
    },
    ...(["answer", "edit", "approve", "cancel", "retry"] as const).map((action): Route => ({
      path: "/api/knowledge/tasks/" + action,
      method: "POST",
      handler: protect(async ({ req, url, res }, owner) => {
        if (url.search) throw new KnowledgeTaskError("invalidInput");
        const p = knowledgeObject(await readJsonBody(req, 1024 * 1024), [
            "id",
            ...(action === "answer"
              ? ["answers"]
              : action === "edit"
                ? ["revision", "draft"]
                : action === "approve"
                  ? ["revision", "previousState"]
                  : []),
          ]),
          id = knowledgeId(p.id);
        const task =
          action === "answer"
            ? await service.answer(owner, id, { answers: p.answers })
            : action === "edit"
              ? await service.edit(owner, id, { revision: p.revision, draft: p.draft })
              : action === "approve"
                ? await service.approve(owner, id, {
                    revision: p.revision,
                    ...(p.previousState === undefined ? {} : { previousState: p.previousState }),
                  })
                : action === "cancel"
                  ? await service.cancel(owner, id)
                  : await service.retry(owner, id);
        respondJson(res, 200, { task });
      }),
    })),
  ];
}
