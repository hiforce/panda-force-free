import { botQueueQuery } from "./queue-query.js";
import { matchesRequestOrigin } from "../auth/origin.js";
import type { BotRepository } from "./repository.js";
import type { ApplicationToolEngine } from "../../shared/engine/application-tools.js";
import type { BotConfig, BotReviewAnswer } from "../../shared/bots/contracts.js";
import { botHasCallbackDecision } from "../../shared/bots/actions.js";
import { join } from "node:path";
import { isRecord } from "../../shared/records.js";
import { BotError, botTaskInput } from "../../shared/bots/contracts.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import type { CodexConnection } from "../engines/codex-transport.js";
import { createCodexApplicationEngine } from "../engines/application-tools/codex.js";
import { BotStore } from "./store.js";
import { BotWorker } from "./worker.js";
import { prepareBotProfile } from "./profile.js";
import { createBotIntegrationFeature } from "./integrations/feature.js";
import { createBotWorkspaceFeature } from "./workspace/feature.js";

export function createBotFeature(options: {
  stateRoot: string;
  version: string;
  connection: CodexConnection;
  owner(context: RouteContext): string;
  engine?: (bot: BotConfig) => ApplicationToolEngine;
  chatEngine?: (bot: BotConfig) => ApplicationToolEngine;
  store?: BotRepository;
}) {
  const store = options.store ?? new BotStore(join(options.stateRoot, "data", "bot-tasks.sqlite")),
    scratchRoot = join(options.stateRoot, "bots");
  const worker = new BotWorker(
    store,
    options.engine ??
      ((bot) =>
        createCodexApplicationEngine({
          connection: options.connection,
          scratchDirectory: join(scratchRoot, bot.id),
          version: options.version,
          purpose: "bots",
          ...(bot.model ? { model: bot.model } : {}),
          timeoutMs: 180000,
        })),
    scratchRoot,
  );
  let closed = false;
  const integrations = createBotIntegrationFeature({
    ...options,
    store,
    wakeTasks: () => {
      worker.tick();
    },
  });
  const workspace = createBotWorkspaceFeature({ ...options, store, engine: options.chatEngine });
  const guard = (handler: (context: RouteContext) => Promise<void>) => async (context: RouteContext) => {
    try {
      if (closed) throw new BotError("unavailable", 503);
      await handler(context);
    } catch (error) {
      if (error instanceof BotError && [429, 503].includes(error.status)) context.res.setHeader("Retry-After", "1");
      respondJson(context.res, error instanceof BotError ? error.status : 400, {
        error: { code: error instanceof BotError ? error.code : "invalidRequest" },
      });
    }
  };
  const json = async (context: RouteContext) => {
    const value = await readJsonBody(context.req, 512000);
    if (!isRecord(value)) throw new BotError("invalidInput");
    return value;
  };
  const routes: Route[] = [
    {
      path: (path) => path === "/api/bots" || path.startsWith("/api/bots/"),
      method: ["GET", "POST", "PATCH", "DELETE"],
      handler: guard(async (context) => {
        const owner = options.owner(context),
          { pathname } = context.url,
          method = context.req.method;
        if (
          method !== "GET" &&
          !matchesRequestOrigin({
            hostHeader: context.req.headers.host,
            origin: context.req.headers.origin,
            fetchSite: context.req.headers["sec-fetch-site"],
          })
        )
          throw new BotError("forbidden", 403);
        if (pathname === "/api/bots" && method === "GET") {
          respondJson(context.res, 200, {
            bots: await store.bots(owner),
            tasks: await store.tasks(owner),
            keys: await store.keys(owner),
          });
          return;
        }
        if (pathname === "/api/bots/retention") {
          const value =
            method === "GET"
              ? await store.retention(owner)
              : method === "POST"
                ? await store.setRetention(owner, (await json(context)).days)
                : null;
          if (!value) throw new BotError("methodNotAllowed", 405);
          respondJson(context.res, 200, value);
          return;
        }
        if (pathname === "/api/bots/catalog" && method === "GET") {
          respondJson(context.res, 200, { bots: await store.bots(owner), keys: await store.keys(owner) });
          return;
        }
        if (pathname === "/api/bots/queue" && method === "GET") {
          respondJson(context.res, 200, {
            bots: (await store.bots(owner)).map((bot) => ({
              id: bot.id,
              name: bot.name,
              active: bot.active,
              avatar: bot.avatar,
              role: bot.persona?.role,
            })),
            ...(await store.queue(owner, botQueueQuery(context.url.searchParams))),
          });
          return;
        }
        if (pathname === "/api/bots" && method === "POST") {
          const prepared = await prepareBotProfile(owner, await json(context));
          respondJson(context.res, 201, {
            bot: await store.configureBot(owner, prepared.value, undefined, prepared.image),
          });
          return;
        }
        const avatar = /^\/api\/bots\/avatars\/([a-f0-9]{64})$/.exec(pathname);
        if (avatar && method === "GET") {
          const bytes = await store.avatars.read(owner, avatar[1]!);
          context.res.setHeader("Content-Type", "image/webp");
          context.res.setHeader("X-Content-Type-Options", "nosniff");
          context.res.setHeader("Cache-Control", "private, no-cache");
          context.res.setHeader("Vary", "Cookie, Authorization");
          context.res.setHeader("ETag", '"' + avatar[1] + '"');
          if (context.req.headers["if-none-match"] === '"' + avatar[1] + '"') {
            context.res.writeHead(304);
            context.res.end();
          } else {
            context.res.writeHead(200);
            context.res.end(bytes);
          }
          return;
        }
        if (pathname === "/api/bots/keys" && method === "POST") {
          respondJson(context.res, 201, await store.issue(owner, await json(context)));
          return;
        }
        const key = /^\/api\/bots\/keys\/([^/]+)$/.exec(pathname);
        if (key && method === "DELETE") {
          await store.revoke(owner, key[1]!);
          respondJson(context.res, 200, { ok: true });
          return;
        }
        const bot = /^\/api\/bots\/([^/]+)$/.exec(pathname);
        if (bot && method === "GET") {
          respondJson(context.res, 200, { bot: await store.bot(owner, bot[1]!) });
          return;
        }
        if (bot && method === "PATCH") {
          const prepared = await prepareBotProfile(owner, await json(context));
          respondJson(context.res, 200, {
            bot: await store.configureBot(owner, prepared.value, bot[1]!, prepared.image),
          });
          worker.tick();
          return;
        }
        const task = /^\/api\/bots\/tasks\/([^/]+)(?:\/(review|retry|cancel|suspend|resume))?$/.exec(pathname);
        if (pathname === "/api/bots/tasks/delete" && method === "POST") {
          const result = await store.bulkDelete(owner, await json(context));
          for (const id of result.interrupted) worker.interrupt(id);
          respondJson(context.res, 200, result);
          return;
        }
        if (pathname === "/api/bots/tasks/retry-failed" && method === "POST") {
          const result = await store.retryFailed(owner, await json(context));
          worker.tick();
          respondJson(context.res, 200, result);
          return;
        }
        if (task && !task[2] && method === "DELETE") {
          await store.deleteTask(owner, task[1]!);
          respondJson(context.res, 200, { ok: true });
          return;
        }
        if (task && method === "GET") {
          respondJson(context.res, 200, {
            task: await store.task(owner, task[1]!),
            events: await store.events(owner, task[1]!),
          });
          return;
        }
        if (task && method === "POST") {
          const value = await json(context);
          if (["cancel", "suspend", "resume"].includes(task[2] || "")) {
            if (Object.keys(value).length) throw new BotError("invalidInput");
            const result = await store.lifecycle(owner, task[1]!, task[2] as "cancel" | "suspend" | "resume");
            if (task[2] !== "resume") worker.interrupt(result.id);
            else worker.tick();
            respondJson(context.res, 200, { task: result });
            return;
          }
          if (task[2] === "retry") {
            if (value.confirm !== true) throw new BotError("confirmationRequired");
            const current = await store.task(owner, task[1]!);
            if (!["callback_failed", "callback_unknown"].includes(current.status))
              throw new BotError("invalidState", 409);
            if (!current.decision || !botHasCallbackDecision(current)) throw new BotError("invalidAction", 409);
            respondJson(context.res, 200, { task: await store.review(owner, current.id, current.decision) });
            worker.tick();
            return;
          }
          if (task[2] !== "review") throw new BotError("invalidInput");
          const legacy = Object.keys(value).length === 1 && ["keep", "discard"].includes(String(value.decision));
          respondJson(context.res, 200, {
            task: await store.review(
              owner,
              task[1]!,
              legacy ? String(value.decision) : (value as unknown as BotReviewAnswer),
            ),
          });
          worker.tick();
          return;
        }
        throw new BotError("notFound", 404);
      }),
    },
  ];
  return {
    routes: [...integrations.routes, ...workspace.routes, ...routes],
    gadgetSummary: async (owner: string) => {
      const queue = await store.queue(owner, botQueueQuery(new URLSearchParams("limit=25")));
      return { counts: queue.counts ?? {}, total: queue.total };
    },
    isSession: (id: string) => store.hasSession(id),
    start: () => {
      worker.start();
      workspace.start();
      integrations.start();
    },
    async handle(context: RouteContext) {
      if (!context.url.pathname.startsWith("/api/v1/bots/")) return false;
      await guard(async (context) => {
        const authorization = context.req.headers.authorization ?? "",
          grant = await store.authenticate(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
        const match = /^\/api\/v1\/bots\/([a-z][a-z0-9_-]{1,63})\/tasks(?:\/(delete|[a-f0-9-]+)(?:\/(cancel))?)?$/.exec(
          context.url.pathname,
        );
        if (!match) throw new BotError("notFound", 404);
        const bot = await store.bot(grant.owner, match[1]!);
        if (!grant.botIds.includes(bot.id)) throw new BotError("forbidden", 403);
        if (context.req.method === "POST" && match[2] === "delete" && !match[3]) {
          const result = await store.bulkDelete(grant.owner, await json(context), bot.id);
          for (const id of result.interrupted) worker.interrupt(id);
          respondJson(context.res, 200, result);
          return;
        }
        if (context.req.method === "POST" && !match[2]) {
          const idem = context.req.headers["idempotency-key"];
          if (typeof idem !== "string") throw new BotError("idempotencyKeyRequired");
          const result = await store.submit(bot, botTaskInput(await json(context)), idem);
          respondJson(context.res, result.duplicate ? 200 : 202, { task: result.task, duplicate: result.duplicate });
          worker.tick();
          return;
        }
        if (context.req.method === "POST" && match[2] && match[3] === "cancel") {
          const current = await store.task(grant.owner, match[2]);
          if (current.botId !== bot.id) throw new BotError("notFound", 404);
          if (Object.keys(await json(context)).length) throw new BotError("invalidInput");
          const task = await store.lifecycle(grant.owner, current.id, "cancel");
          worker.interrupt(task.id);
          respondJson(context.res, 200, { task });
          return;
        }
        if (context.req.method === "GET" && match[2] && !match[3]) {
          const task = await store.task(grant.owner, match[2]);
          if (task.botId !== bot.id) throw new BotError("notFound", 404);
          respondJson(context.res, 200, { task });
          return;
        }
        throw new BotError("methodNotAllowed", 405);
      })(context);
      return true;
    },
    async close() {
      closed = true;
      await integrations.close();
      await workspace.close();
      await worker.close();
      await store.close();
    },
  };
}
