import { rpcErrorPayload } from "../../shared/bridge-errors.js";

export type DispatchContext = {
  method: string;
  params: any;
  /** PandaForce-only hints stripped from the native RPC params. */
  flags: { pandaProjectless?: unknown; pandaPrepareInput?: unknown };
  result?: any;
  /** Extra top-level fields merged into the rpc/result reply. */
  replyExtras: Record<string, any>;
};

/**
 * Browser bridge message dispatcher. The protocol (allow-list, reply
 * envelopes, approval forwarding) lives here; per-method behavior is
 * registered as hooks so RPC side effects stay with their owners:
 *
 * - before(hook): runs for every allowed RPC before resolution; may
 *   mutate params or throw to reject.
 * - handle(method, fn): terminal handler — replaces the request and
 *   skips resolvers/after hooks (the reply is fn's return value).
 * - resolve(method, fn): replaces the native request when fn returns a
 *   value; returning undefined falls through to the next resolver or
 *   the native request. After hooks still run.
 * - after(hook): post-resolution side effects; may add replyExtras.
 */
export function createBrowserDispatch({
  isAllowedMethod,
  request,
  pendingServerRequests,
  sendRaw,
  broadcast,
}: {
  isAllowedMethod: (method: string) => boolean;
  request: (method: string, params?: any) => Promise<any>;
  pendingServerRequests: Map<number | string, any>;
  sendRaw: (message: any) => void;
  broadcast: (data: any) => void;
}) {
  const terminals = new Map<string, (ctx: DispatchContext) => any>();
  const resolvers = new Map<string, Array<(ctx: DispatchContext) => any>>();
  const beforeHooks: Array<(ctx: DispatchContext) => void> = [];
  const afterHooks: Array<(ctx: DispatchContext) => void | Promise<void>> = [];

  async function dispatch(message: any) {
    const id = message?.id;
    if (message?.type === "rpc") {
      try {
        if (!isAllowedMethod(message.method)) throw new Error("RPC method is not available to browser clients");
        // The panda* hints are not part of the native Codex RPC schema.
        const { pandaProjectless, pandaPrepareInput, ...params } = message.params || {};
        const ctx: DispatchContext = {
          method: message.method,
          params,
          flags: { pandaProjectless, pandaPrepareInput },
          replyExtras: {},
        };
        for (const hook of beforeHooks) hook(ctx);
        const terminal = terminals.get(ctx.method);
        if (terminal) return { type: "rpc/result", id, result: await terminal(ctx) };
        let result;
        for (const resolver of resolvers.get(ctx.method) || []) {
          result = await resolver(ctx);
          if (result !== undefined) break;
        }
        if (result === undefined) result = await request(ctx.method, ctx.params);
        ctx.result = result;
        for (const hook of afterHooks) await hook(ctx);
        return { type: "rpc/result", id, result, ...ctx.replyExtras };
      } catch (error) {
        return rpcErrorPayload(id, error);
      }
    }
    if (message?.type === "codex/response" || message?.type === "codex/error") {
      if (!(
        Number.isSafeInteger(message.requestId) ||
        (typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 256)
      ))
        throw new Error("Invalid Codex request id");
      // Several browser clients can display one approval. Only forward the first answer.
      if (!pendingServerRequests.has(message.requestId)) return { type: "ack", id };
      sendRaw(
        message.type === "codex/error"
          ? { id: message.requestId, error: message.error }
          : { id: message.requestId, result: message.result },
      );
      pendingServerRequests.delete(message.requestId);
      broadcast({
        type: "codex/notification",
        payload: { method: "serverRequest/resolved", params: { requestId: message.requestId } },
      });
      return { type: "ack", id };
    }
    if (message?.type === "ping") return { type: "pong" };
    throw new Error("Unsupported browser bridge message");
  }

  return {
    dispatch,
    handle(method: string, fn: (ctx: DispatchContext) => any) {
      terminals.set(method, fn);
    },
    resolve(method: string, fn: (ctx: DispatchContext) => any) {
      const list = resolvers.get(method) || [];
      list.push(fn);
      resolvers.set(method, list);
    },
    before(hook: (ctx: DispatchContext) => void) {
      beforeHooks.push(hook);
    },
    after(hook: (ctx: DispatchContext) => void | Promise<void>) {
      afterHooks.push(hook);
    },
  };
}
