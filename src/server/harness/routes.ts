import { HarnessError } from "../../shared/harness/contracts.js";
import type { HarnessSourcePage } from "./ports.js";
import { isRecord } from "../../shared/records.js";
import type { Route, RouteContext } from "../http/router.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { HarnessRegistry, type HarnessPrincipal } from "./registry.js";
import { HarnessConversations } from "./conversations.js";
import type { HarnessDiagnostics } from "./diagnostics.js";
export function harnessRoutes(options: {
  registry: HarnessRegistry;
  conversations: HarnessConversations;
  diagnostics: HarnessDiagnostics;
  principal(context: RouteContext): HarnessPrincipal;
  defaultCwd: string;
  importSession(principal: HarnessPrincipal, id: string): Promise<HarnessSourcePage>;
}): Route[] {
  const route = (
    path: Route["path"],
    methods: string[],
    work: (context: RouteContext, principal: HarnessPrincipal) => Promise<unknown>,
  ): Route => ({
    path,
    method: methods,
    handler: async (context) => {
      try {
        const value = await work(context, options.principal(context));
        respondJson(context.res, context.req.method === "POST" ? 201 : 200, value);
      } catch (error) {
        const known = error instanceof HarnessError ? error : new HarnessError("unavailable", 503);
        respondJson(context.res, known.status, {
          error: `harness.error${known.code[0]!.toUpperCase()}${known.code.slice(1)}`,
          messageId: `harness.error${known.code[0]!.toUpperCase()}${known.code.slice(1)}`,
          code: known.code,
        });
      }
    },
  });
  const root = "/api/personal/harness/conversations";
  return [
    route(
      (path) => /^\/api\/harness-runtimes(?:\/[^/]+(?:\/(?:probe|ping))?)?$/.test(path),
      ["GET", "POST", "PATCH", "DELETE"],
      async (context, principal) => {
        const segments = context.url.pathname.split("/").filter(Boolean),
          id = segments[2];
        if (context.req.method === "GET") {
          if (id) throw new HarnessError("notFound", 404);
          return options.registry.catalog(principal);
        }
        if (segments[3] === "probe") {
          if (context.req.method !== "POST") throw new HarnessError("invalidInput");
          return options.registry.probe(principal, id!, options.defaultCwd);
        }
        const input = await readJsonBody(context.req);
        if (context.req.method === "DELETE") {
          if (!id || segments[3] || !Number.isSafeInteger(input.revision)) throw new HarnessError("invalidInput");
          return options.registry.remove(principal, id, Number(input.revision));
        }
        if (segments[3] === "ping") {
          if (context.req.method !== "POST" || typeof input.requestId !== "string")
            throw new HarnessError("invalidInput");
          return options.diagnostics.ping(principal, id!, input.requestId);
        }
        if ((id && context.req.method !== "PATCH") || (!id && context.req.method !== "POST"))
          throw new HarnessError("invalidInput");
        if (
          typeof input.name !== "string" ||
          typeof input.profileId !== "string" ||
          typeof input.enabled !== "boolean" ||
          (input.botEnabled !== undefined && typeof input.botEnabled !== "boolean") ||
          !["administrators", "members"].includes(String(input.access)) ||
          (input.revision !== undefined && !Number.isSafeInteger(input.revision)) ||
          (input.makeDefault !== undefined && typeof input.makeDefault !== "boolean") ||
          (input.defaultModel !== null && typeof input.defaultModel !== "string") ||
          (input.defaultEffort !== null && typeof input.defaultEffort !== "string")
        )
          throw new HarnessError("invalidInput");
        return options.registry.configure(principal, {
          id,
          revision: Number(input.revision) || 0,
          name: input.name,
          profileId: input.profileId,
          enabled: input.enabled,
          ...(input.botEnabled === undefined ? {} : { botEnabled: input.botEnabled }),
          access: input.access as "administrators" | "members",
          defaultModel: input.defaultModel as string | null,
          defaultEffort: input.defaultEffort as string | null,
          makeDefault: input.makeDefault === true,
        });
      },
    ),
    route("/api/personal/harness/import", ["POST"], async (context, principal) => {
      if (!principal.administrator) throw new HarnessError("forbidden", 403);
      const input = await readJsonBody(context.req);
      if (typeof input.threadId !== "string" || typeof input.runtimeId !== "string")
        throw new HarnessError("invalidInput");
      const imported = await options.importSession(principal, input.threadId);
      return options.conversations.create(principal, {
        ...imported,
        runtimeId: input.runtimeId,
        ...(imported.cursor ? { source: { threadId: input.threadId, cursor: imported.cursor } } : {}),
      });
    }),
    route(
      (path) => path === root || path.startsWith(root + "/"),
      ["GET", "POST", "PATCH", "DELETE"],
      async (context, principal) => {
        const segments = context.url.pathname.slice(root.length).split("/").filter(Boolean),
          id = segments[0],
          action = segments[1];
        if (context.req.method === "DELETE") {
          if (!id || action || segments.length !== 1) throw new HarnessError("notFound", 404);
          const impactToken = context.url.searchParams.get("memoryImpact") ?? undefined;
          if (impactToken !== undefined && !/^[a-f0-9]{64}$/u.test(impactToken)) throw new HarnessError("invalidInput");
          await options.conversations.delete(principal, id, impactToken);
          return {};
        }
        const input = context.req.method === "GET" ? {} : await readJsonBody(context.req, 512 * 1024);
        if (!id && context.req.method === "GET") return { conversations: await options.conversations.list(principal) };
        if (!id && context.req.method === "POST") {
          if (
            (input.cwd !== undefined && typeof input.cwd !== "string") ||
            (input.projectId !== undefined && input.projectId !== null && typeof input.projectId !== "string") ||
            (input.runtimeId !== undefined && typeof input.runtimeId !== "string") ||
            (input.memoryPrivate !== undefined && typeof input.memoryPrivate !== "boolean")
          )
            throw new HarnessError("invalidInput");
          return options.conversations.create(principal, {
            runtimeId: input.runtimeId as string | undefined,
            permissionMode: input.permissionMode as
              import("../../shared/harness/contracts.js").HarnessPermissionMode | undefined,
            projectId: input.projectId as string | undefined,
            cwd: input.cwd as string | undefined,
            memoryPrivate: input.memoryPrivate === true,
          });
        }
        if (!id) throw new HarnessError("notFound", 404);
        if (segments.length === 2 && action === "memory-summary" && context.req.method === "GET") {
          context.res.setHeader("Cache-Control", "private, no-store");
          return options.conversations.memorySummary(principal, id);
        }
        if (segments.length === 2 && (action === "memory" || action === "memory-policy")) {
          context.res.setHeader("Cache-Control", "private, no-store");
          if (context.req.method === "GET")
            return action === "memory"
              ? options.conversations.memoryDetails(principal, id)
              : options.conversations.memorySettings(principal, id);
          if (context.req.method === "PATCH" && action === "memory-policy") {
            if (
              !Number.isSafeInteger(input.revision) ||
              !(input.write === undefined || input.write === null || typeof input.write === "boolean") ||
              !(input.recall === undefined || input.recall === null || typeof input.recall === "boolean") ||
              (input.paused !== undefined && typeof input.paused !== "boolean") ||
              (input.paused === undefined &&
                input.revoke !== true &&
                input.write === undefined &&
                input.recall === undefined) ||
              (input.revoke !== undefined && typeof input.revoke !== "boolean") ||
              (input.impactToken !== undefined &&
                (typeof input.impactToken !== "string" || !/^[a-f0-9]{64}$/u.test(input.impactToken)))
            )
              throw new HarnessError("invalidInput");
            return options.conversations.configureMemory(principal, id, {
              revision: Number(input.revision),
              write: input.write,
              recall: input.recall,
              paused: input.paused,
              revoke: input.revoke === true,
              impactToken: typeof input.impactToken === "string" ? input.impactToken : undefined,
            });
          }
          throw new HarnessError("notFound", 404);
        }
        if (segments.length === 2 && action === "memory-removal-impact" && context.req.method === "GET") {
          context.res.setHeader("Cache-Control", "private, no-store");
          return options.conversations.memoryRemovalImpact(principal, id);
        }
        if (segments.length === 2 && action === "memory-refresh" && context.req.method === "POST") {
          context.res.setHeader("Cache-Control", "private, no-store");
          return options.conversations.retryMemory(principal, id);
        }
        if (segments.length === 2 && action === "memory-backfill") {
          context.res.setHeader("Cache-Control", "private, no-store");
          if (context.req.method === "GET") return options.conversations.memoryBackfill(principal, id);
          if (context.req.method === "POST")
            return options.conversations.memoryBackfill(principal, id, {
              from: input.from,
              to: input.to,
              requestId: input.requestId,
            });
          throw new HarnessError("notFound", 404);
        }
        if (action === "history" && context.req.method === "GET") {
          const from = context.url.searchParams.get("from"),
            to = context.url.searchParams.get("to");
          if (!from || !to || !/(?:Z|[+-]\d{2}:\d{2})$/.test(from) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(to))
            throw new HarnessError("invalidInput");
          let cursor: { indexOffset: number; afterSeq?: number } | undefined;
          try {
            const value = context.url.searchParams.get("cursor");
            if (value) cursor = JSON.parse(value) as typeof cursor;
          } catch {
            throw new HarnessError("invalidInput");
          }
          return options.conversations.history(principal, id, {
            from: Date.parse(from),
            to: Date.parse(to),
            query: context.url.searchParams.get("query") ?? undefined,
            cursor,
            limit: 30,
          });
        }
        if (action === "checkpoint" && context.req.method === "POST" && typeof input.text === "string") {
          await options.conversations.checkpoint(principal, id, input.text);
          return {};
        }
        if (!action && context.req.method === "GET") {
          const cursor = context.url.searchParams.get("cursor");
          if (cursor?.startsWith("source:")) {
            if (cursor.length > 32768) throw new HarnessError("invalidInput");
            let source: unknown;
            try {
              source = JSON.parse(Buffer.from(cursor.slice(7), "base64url").toString());
            } catch {
              throw new HarnessError("invalidInput");
            }
            if (
              !isRecord(source) ||
              typeof source.cursor !== "string" ||
              !source.cursor ||
              !Number.isSafeInteger(source.beforeSeq)
            )
              throw new HarnessError("invalidInput");
            return options.conversations.snapshot(principal, id, {
              beforeBytes: 0,
              sourceCursor: source.cursor,
              beforeSeq: Number(source.beforeSeq),
            });
          }
          return options.conversations.snapshot(principal, id, cursor ? { beforeBytes: Number(cursor) } : {});
        }
        if (!action && context.req.method === "PATCH") {
          if (input.permissionMode !== undefined && Number.isSafeInteger(input.revision))
            return options.conversations.configurePermission(
              principal,
              id,
              input.permissionMode,
              Number(input.revision),
            );
          if (typeof input.runtimeId === "string" && Number.isSafeInteger(input.revision))
            return options.conversations.switch(principal, id, input.runtimeId, Number(input.revision));
          if (typeof input.title === "string") {
            await options.conversations.rename(principal, id, input.title);
            return options.conversations.snapshot(principal, id);
          }
          throw new HarnessError("invalidInput");
        }
        if (context.req.method !== "POST") throw new HarnessError("notFound", 404);
        if (action === "runs") {
          if (
            typeof input.requestId !== "string" ||
            typeof input.text !== "string" ||
            (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) ||
            (input.model !== undefined && input.model !== null && typeof input.model !== "string") ||
            (input.effort !== undefined && input.effort !== null && typeof input.effort !== "string")
          )
            throw new HarnessError("invalidInput");
          return options.conversations.submit(principal, id, {
            requestId: input.requestId,
            clientId: input.clientId as string | undefined,
            text: input.text,
            attachmentIds: input.attachmentIds as string[] | undefined,
            model: input.model as string | null | undefined,
            effort: input.effort as string | null | undefined,
          });
        }
        if (action === "cancel") {
          await options.conversations.cancel(principal, id);
          return {};
        }
        if (action === "recover") {
          await options.conversations.resolveUncertain(principal, id);
          return {};
        }
        if (
          action === "permissions" &&
          typeof input.id === "string" &&
          (input.optionId === null || typeof input.optionId === "string")
        ) {
          await options.conversations.permission(principal, id, input.id, input.optionId);
          return {};
        }
        if (isRecord(input)) throw new HarnessError("notFound", 404);
        throw new HarnessError("invalidInput");
      },
    ),
  ];
}
