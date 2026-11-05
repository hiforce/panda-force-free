import { fetchProfileAvatar, resolveAccountIdentity, toPublicAccountIdentity } from "../misc/profile.js";
import { threadFromResult } from "../protocol/native.js";
import { applyReviewPatch } from "../review/apply.js";
import { parseReviewPatchRequest } from "../review/state.js";
import { errorMessage } from "./../../shared/errors.js";
import type { RuntimeServices } from "./../services.js";
import { respondError, respondJson } from "./respond.js";
import type { Route } from "./router.js";

/** Owns account routes. Dependencies are supplied by the composition root. */
export function accountRoutes({
  reviewRoots,
  appServerConnection,
  reviewDiffs,
  threadHub,
  accountLoader,
  request,
}: Pick<
  RuntimeServices,
  "reviewRoots" | "appServerConnection" | "reviewDiffs" | "threadHub" | "accountLoader" | "request"
>): Route[] {
  return [
    {
      path: ["/api/account", "/api/account/avatar"],
      handler: async ({ res, url }) => {
        try {
          const account = await accountLoader.get(url.searchParams.get("refresh") === "1");
          if (url.pathname === "/api/account") {
            respondJson(res, 200, toPublicAccountIdentity(account));
            return;
          }
          if (!account.imageUrl) {
            respondJson(res, 404, { error: "No profile avatar" });
            return;
          }
          const avatar = await fetchProfileAvatar(account.imageUrl);
          res.writeHead(200, {
            "content-type": avatar.contentType,
            "content-length": String(avatar.body.byteLength),
            "cache-control": "private, max-age=300",
            "x-content-type-options": "nosniff",
          });
          res.end(avatar.body);
        } catch (error) {
          console.warn(
            "[panda-force] account request failed:",
            error instanceof Error ? errorMessage(error) : String(error),
          );
          if (url.pathname === "/api/account/avatar") {
            respondJson(res, 502, { error: "Profile avatar unavailable" });
            return;
          }
          respondJson(
            res,
            200,
            toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true })),
          );
        }
      },
    },
    {
      path: "/api/review/patch",
      method: "POST",
      handler: ({ req, res }) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
        });
        req.on("end", async () => {
          let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
          let operationStarted = false;
          let success = false;
          try {
            const payload = JSON.parse(body || "{}");
            requestPayload = parseReviewPatchRequest(payload);
            const stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
            operationStarted = true;
            const threadResult =
              appServerConnection.mode === "shared"
                ? { thread: await threadHub.getThreadMetadata(requestPayload.threadId) }
                : await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
            const cwd = threadFromResult(threadResult)?.cwd;
            if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
            const result = await applyReviewPatch(
              { cwd, diff: stored.diff, action: requestPayload.action },
              reviewRoots,
            );
            success = true;
            respondJson(res, 200, result);
          } catch (error) {
            respondError(res, 400, error);
          } finally {
            if (operationStarted && requestPayload)
              reviewDiffs.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
          }
        });
      },
    },
  ];
}
