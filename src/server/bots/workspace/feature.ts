import { join } from "node:path";
import { BotError, type BotConfig } from "../../../shared/bots/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";
import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import { registerApplicationRoot } from "../../engines/application-tools/sessions.js";
import { createCodexApplicationEngine } from "../../engines/application-tools/codex.js";
import type { CodexConnection } from "../../engines/codex-transport.js";
import type { BotRepository } from "../repository.js";
import { BotChatService } from "./chat-service.js";
import { BotChatWorker } from "./chat-worker.js";
import { botWorkspaceOverview } from "./overview.js";
import type { BotChatContextPort } from "./chat-context.js";
import { requestLocale } from "../../i18n/request-locale.js";
import type { ApplicationRuntimePort } from "../../engines/application-tools/runtime-port.js";

export function createBotWorkspaceFeature(options: {
  stateRoot: string;
  version: string;
  connection: CodexConnection;
  store: BotRepository;
  owner(context: RouteContext): string;
  engine?: (bot: BotConfig) => ApplicationToolEngine;
  chatContext?: BotChatContextPort;
  runtimes?: ApplicationRuntimePort;
}) {
  const root = join(options.stateRoot, "bots", "human"),
    directory = (id: string) => join(root, id),
    service = new BotChatService(
      options.store,
      options.chatContext,
      options.runtimes
        ? async (owner, bot) => {
            try {
              return await options.runtimes!.resolve(owner, bot, "bots");
            } catch {
              throw new BotError("runtimeSelectionUnavailable", 409);
            }
          }
        : undefined,
    ),
    worker = new BotChatWorker(
      options.store,
      options.engine ??
        ((bot) =>
          options.runtimes
            ? options.runtimes.engine(bot.owner, bot, directory(bot.id), "bot-chat")
            : createCodexApplicationEngine({
                connection: options.connection,
                scratchDirectory: directory(bot.id),
                version: options.version,
                purpose: "bot-chat",
                ...(bot.model ? { model: bot.model } : {}),
                effort: bot.effort ?? "",
                timeoutMs: 180000,
              })),
      directory,
      options.chatContext,
    );
  registerApplicationRoot(root);
  let closed = false;
  const routes: Route[] = [
    {
      path: (path) =>
        ["/api/bots/workspace", "/api/bots/navigation"].includes(path) ||
        /^\/api\/bots\/[a-f0-9-]{36}\/chat(?:\/(?:clear|cleanup\/retry))?$/.test(path),
      method: ["GET", "POST"],
      async handler(context) {
        try {
          if (closed) throw new BotError("unavailable", 503);
          const owner = options.owner(context),
            method = context.req.method,
            path = context.url.pathname;
          if (
            method !== "GET" &&
            !matchesRequestOrigin({
              hostHeader: context.req.headers.host,
              origin: context.req.headers.origin,
              fetchSite: context.req.headers["sec-fetch-site"],
            })
          )
            throw new BotError("forbidden", 403);
          if (path === "/api/bots/workspace" && method === "GET") {
            respondJson(context.res, 200, await botWorkspaceOverview(options.store, owner));
            return;
          }
          if (path === "/api/bots/navigation" && method === "GET") {
            respondJson(context.res, 200, {
              bots: (await options.store.bots(owner)).map(({ id, name, avatar }) => ({ id, name, avatar })),
            });
            return;
          }
          const match = /^\/api\/bots\/([a-f0-9-]{36})\/chat(?:\/(clear|cleanup\/retry))?$/.exec(path);
          if (!match) throw new BotError("methodNotAllowed", 405);
          const botId = match[1]!;
          if (method === "GET" && !match[2]) {
            const before = context.url.searchParams.get("before"),
              value = before === null ? undefined : Number(before);
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new BotError("invalidInput");
            const since = context.url.searchParams.get("since") ?? undefined;
            if (since && since.length > 160) throw new BotError("invalidInput");
            respondJson(context.res, 200, await service.changes(owner, botId, since, value));
            return;
          }
          if (method !== "POST") throw new BotError("methodNotAllowed", 405);
          const value = await readJsonBody(context.req, 150000);
          if (!isRecord(value)) throw new BotError("invalidInput");
          if (match[2] === "cleanup/retry") {
            if (Object.keys(value).length) throw new BotError("invalidInput");
            await worker.retryCleanup(owner, botId);
            respondJson(context.res, 200, { ok: true });
            return;
          }
          const result =
            match[2] === "clear"
              ? await service.clear(owner, botId, value)
              : await service.send(owner, botId, value, requestLocale(context.req));
          if (match[2] === "clear") worker.interrupt(owner, botId);
          void worker.tick();
          respondJson(context.res, result.duplicate ? 200 : 202, result);
        } catch (error) {
          respondJson(
            context.res,
            error instanceof BotError || error instanceof RequestBodyError ? error.status : 503,
            {
              error: {
                code:
                  error instanceof BotError
                    ? error.code
                    : error instanceof RequestBodyError
                      ? "invalidInput"
                      : "unavailable",
              },
            },
          );
        }
      },
    },
  ];
  return {
    routes,
    start: () => worker.start(),
    async close() {
      closed = true;
      await worker.close();
    },
  };
}
