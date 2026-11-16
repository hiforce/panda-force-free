import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { knowledgeObject, knowledgeId } from "../../../shared/knowledge/primitives.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import type { KnowledgeGenerationSettings } from "../generation/service.js";
import { knowledgeHttp } from "./http.js";

export function knowledgeGenerationRoutes(
  service: Pick<KnowledgeGenerationSettings, "policy" | "configure" | "preview" | "sources" | "status">,
  options: {
    owner(context: RouteContext): string;
    report(error: unknown): void;
    available(): boolean;
  },
): Route[] {
  const { protect, query } = knowledgeHttp(options);
  return [
    {
      path: "/api/knowledge/generation-status",
      method: "GET",
      handler: protect(async ({ url, res }, owner) => {
        respondJson(res, 200, await service.status(owner, query(url, "project")));
      }),
    },
    {
      path: "/api/knowledge/generation-sources",
      method: "POST",
      handler: protect(async ({ req, url, res }, owner) => {
        if (url.search) throw new KnowledgeTaskError("invalidInput");
        const p = knowledgeObject(await readJsonBody(req, 4096), ["project", "offset", "commit"]);
        if (
          !Number.isSafeInteger(p.offset) ||
          Number(p.offset) < 0 ||
          Number(p.offset) > 10000 ||
          (p.commit !== undefined && (typeof p.commit !== "string" || !/^(?:[a-f0-9]{40}|empty)$/.test(p.commit)))
        )
          throw new KnowledgeTaskError("invalidInput");
        respondJson(
          res,
          200,
          await service.sources(owner, knowledgeId(p.project), Number(p.offset), p.commit as string | undefined),
        );
      }),
    },
    {
      path: "/api/knowledge/generation-policy",
      method: ["GET", "PUT"],
      handler: protect(async ({ req, url, res }, owner) => {
        if (req.method === "GET")
          return respondJson(res, 200, { policy: await service.policy(owner, query(url, "project")) });
        if (url.search) throw new KnowledgeTaskError("invalidInput");
        const p = knowledgeObject(await readJsonBody(req, 256 * 1024), ["project", "policy", "sourceCommit"]),
          policy = knowledgeObject(p.policy, [
            "enabled",
            "revision",
            "purpose",
            "selection",
            "dailyLimit",
            "pendingLimit",
            "backfill",
          ]);
        if (policy.enabled === true && !options.available()) throw new KnowledgeTaskError("unavailable");
        if (
          p.sourceCommit !== undefined &&
          (typeof p.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|empty)$/.test(p.sourceCommit))
        )
          throw new KnowledgeTaskError("invalidInput");
        respondJson(res, 200, {
          policy: await service.configure(owner, knowledgeId(p.project), policy, p.sourceCommit as string | undefined),
        });
      }),
    },
    {
      path: "/api/knowledge/generation-preview",
      method: "POST",
      handler: protect(async ({ req, url, res }, owner) => {
        if (url.search) throw new KnowledgeTaskError("invalidInput");
        const p = knowledgeObject(await readJsonBody(req, 256 * 1024), ["project", "policy"]);
        respondJson(res, 200, await service.preview(owner, knowledgeId(p.project), p.policy));
      }),
    },
  ];
}
