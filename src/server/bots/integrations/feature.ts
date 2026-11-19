import { BotError } from "../../../shared/bots/contracts.js";
import type { BotRepository } from "../repository.js";
import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody, RequestBodyError } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { matchesRequestOrigin } from "../../auth/origin.js";
import type { SupportedLocale } from "../../../shared/i18n/contracts.js";
import { requestLocale } from "../../i18n/request-locale.js";
import { BotConnections } from "./connections.js";
import { BotIntegrations } from "./configuration.js";
import { BotProviders } from "./providers.js";
import type { BotIntegrationSourcePorts } from "./collection.js";
import { BotIntegrationWorker } from "./worker.js";
import { BotIntegrationChannel } from "./channel.js";
import type { BotIntegrationDelivery } from "./delivery-records.js";

export function createBotIntegrationFeature(options: {
  stateRoot: string;
  store: BotRepository;
  owner(context: RouteContext): string;
  wakeTasks(): void;
  providers?: BotProviders;
  sources?: BotIntegrationSourcePorts;
}) {
  const connections = options.providers?.connections ?? new BotConnections(options.store.workspace, options.stateRoot),
    providers = options.providers ?? new BotProviders(connections),
    integrations = new BotIntegrations(options.store, connections),
    worker = new BotIntegrationWorker(options.store, integrations, providers, options.wakeTasks, options.sources),
    channel = new BotIntegrationChannel(integrations);
  let closed = false;
  const base =
    /^\/api\/bots\/([a-f0-9-]{36})\/integrations(?:\/([a-f0-9-]{36})(?:\/(runs|channel|deliveries)(?:\/([^/]+)(?:\/(cancel|send|retry|reconcile))?)?)?)?$/;
  const routes: Route[] = [
    {
      path: (path) =>
        path === "/api/bots/connections" ||
        /^\/api\/bots\/connections\/[a-f0-9-]{36}(?:\/test)?$/.test(path) ||
        base.test(path),
      method: ["GET", "POST", "DELETE"],
      async handler(context) {
        try {
          if (closed) throw new BotError("unavailable", 503);
          const owner = options.owner(context),
            path = context.url.pathname,
            method = context.req.method,
            signal = AbortSignal.timeout(20000);
          if (
            method !== "GET" &&
            !matchesRequestOrigin({
              hostHeader: context.req.headers.host,
              origin: context.req.headers.origin,
              fetchSite: context.req.headers["sec-fetch-site"],
            })
          )
            throw new BotError("forbidden", 403);
          let result: unknown;
          if (path === "/api/bots/connections") {
            if (method === "GET") result = { connections: await connections.list(owner) };
            else if (method === "POST")
              result = { connection: await connections.save(owner, await readJsonBody(context.req, 48000)) };
            else throw new BotError("methodNotAllowed", 405);
          } else if (path.startsWith("/api/bots/connections/")) {
            const match = /^\/api\/bots\/connections\/([a-f0-9-]{36})(\/test)?$/.exec(path)!;
            if (method === "POST" && match[2])
              result = { connection: await providers.verify(owner, match[1]!, signal) };
            else if (method === "DELETE" && !match[2]) {
              await connections.remove(owner, match[1]!);
              result = { ok: true };
            } else throw new BotError("methodNotAllowed", 405);
          } else {
            const match = base.exec(path)!,
              botId = match[1]!,
              integrationId = match[2],
              section = match[3],
              id = match[4] ? decodeURIComponent(match[4]) : undefined,
              action = match[5],
              before = context.url.searchParams.get("before") ?? undefined;
            if ((before && before.length > 191) || (id && id.length > 191)) throw new BotError("invalidInput");
            await integrations.bot(owner, botId);
            if (!integrationId && method === "GET")
              result = {
                integrations: await integrations.list(owner, botId),
                connections: await connections.list(owner),
              };
            else if (!integrationId && method === "POST")
              result = {
                integration: await integrations.save(
                  owner,
                  botId,
                  await readJsonBody(context.req, 24000),
                  requestLocale(context.req) as SupportedLocale,
                ),
              };
            else if (integrationId && section === "runs") {
              if (method === "GET" && !id) result = await worker.runs.list(owner, botId, integrationId, before);
              else if (method === "GET" && id && !action) {
                const row = await worker.runs.row(owner, botId, integrationId, id);
                result = {
                  run: row.data.view,
                  ...(row.data.view.preview ? { items: row.data.items, limited: row.data.limited } : {}),
                };
              } else if (method === "POST" && !id)
                result = await worker.runs.manual(owner, botId, integrationId, await readJsonBody(context.req, 2000));
              else if (method === "POST" && id && action === "cancel")
                result = { run: await worker.runs.cancel(owner, botId, integrationId, id) };
              else throw new BotError("methodNotAllowed", 405);
            } else if (integrationId && section === "channel") {
              if (method === "GET" && !id) result = await channel.list(owner, botId, integrationId, before);
              else if (method === "POST" && id && action === "send")
                result = await channel.send(owner, botId, integrationId, id, await readJsonBody(context.req, 48000));
              else throw new BotError("methodNotAllowed", 405);
            } else if (integrationId && section === "deliveries") {
              await integrations.row(owner, botId, integrationId);
              if (method === "GET" && !id) {
                const rows = await options.store.workspace.list<BotIntegrationDelivery>(owner, "delivery", {
                  botId,
                  prefix: integrationId + ":",
                  descending: true,
                  limit: 51,
                  liveAt: Date.now(),
                  ...(before ? { before } : {}),
                });
                result = {
                  deliveries: rows.slice(0, 50).map((r) => ({
                    id: r.id,
                    kind: r.data.kind,
                    state: r.state,
                    failure: r.data.failure,
                    receipt: r.data.receipt,
                    dispatchedAt: r.data.dispatchedAt,
                  })),
                  next: rows.length > 50 ? rows[49]!.id : null,
                };
              } else if (method === "POST" && id && ["retry", "reconcile"].includes(action ?? "")) {
                const row = await options.store.workspace.get<BotIntegrationDelivery>(owner, { kind: "delivery", id });
                if (row?.botId !== botId || row.data.integrationId !== integrationId)
                  throw new BotError("notFound", 404);
                result =
                  action === "reconcile"
                    ? await worker.outbox.reconcile(owner, botId, id, signal)
                    : (await worker.outbox.retry(owner, botId, id), { ok: true });
              } else throw new BotError("methodNotAllowed", 405);
            } else throw new BotError("methodNotAllowed", 405);
          }
          if (method !== "GET") void worker.tick();
          respondJson(context.res, 200, result);
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
                      : "integrationUnavailable",
              },
            },
          );
        }
      },
    },
  ];
  return {
    routes,
    worker,
    start: () => worker.start(),
    async close() {
      closed = true;
      await worker.close();
    },
  };
}
