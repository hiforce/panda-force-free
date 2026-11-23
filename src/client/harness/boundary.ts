import { isRecord } from "../../shared/records.js";
import type { ClientRpc, RpcResults } from "../contracts/rpc.js";
import type { SessionControlView } from "../contracts/session-workspace.js";
import type { HarnessBrowserBoundary } from "../contracts/harness.js";
/** One explicit compatibility boundary preserves the legacy browser vocabulary while selecting domain-owned conversations. */
export function createHarnessBrowserBoundary() {
  let delegate: HarnessBrowserBoundary | null = null;
  return {
    attach(boundary: HarnessBrowserBoundary) {
      if (delegate) throw Error("Harness boundary already attached");
      delegate = boundary;
    },
    async rpc<M extends keyof RpcResults>(
      method: M,
      params: Record<string, unknown> = {},
      next: ClientRpc,
    ): Promise<RpcResults[M]> {
      if (!delegate) return next(method, params);
      return (await delegate.rpc(method, params, () => next(method, params))) as RpcResults[M];
    },
    async post(path: string, payload: unknown, next: () => Promise<unknown>) {
      if (path !== "/api/rpc" || !delegate || !isRecord(payload) || payload.method !== "model/list") return next();
      const result = await delegate.rpc("model/list", isRecord(payload.params) ? payload.params : {}, async () => {
        const value = await next();
        if (!isRecord(value) || value.type !== "rpc/result") throw Error("Invalid model response");
        return value.result;
      });
      return { type: "rpc/result", id: payload.id, result };
    },
    controls(view: SessionControlView) {
      return delegate?.controls(view) ?? view;
    },
    syncRoute() {
      delegate?.syncRoute();
    },
    applyPermission(sessionId: string, mode: string) {
      return delegate?.applyPermission(sessionId, mode) ?? Promise.resolve(false);
    },
    applyRuntime(sessionId: string, runtimeId: string) {
      if (!delegate) return Promise.reject(Error("Harness boundary unavailable"));
      return delegate.applyRuntime(sessionId, runtimeId);
    },
    context() {
      return delegate?.context() ?? "codex";
    },
    available() {
      return delegate?.available() ?? false;
    },
    managed() {
      return delegate?.managed() ?? false;
    },
  };
}
