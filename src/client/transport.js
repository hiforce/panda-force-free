import { createBridgeError } from "../shared/bridge-errors.js";
import { reportDiagnostic } from "../shared/diagnostics.js";
import { errorCode } from "./../shared/errors.js";
import { request as fetch } from "./http-client.js";
import { errorText } from "./i18n.js";
const WS_CONNECT_TIMEOUT_MS = 2500;
const TRANSPORT_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const RESPOND_TIMEOUT_MS = 15000;
// Allow the server's 30-second native RPC deadline to report its own error,
// while bounding the wait if an acknowledgement is lost in either transport.
const RPC_TIMEOUT_MS = 45000;
// Retry only reads and explicit input preparation. Creation, input, queue
// mutations and approvals may have committed before a connection was lost.
const RETRYABLE_READS = new Set([
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "host/thread/history",
  "host/thread/live",
  "model/list",
  "permissionProfile/list",
]);
/**
 * Bridge transport: WebSocket with SSE fallback, reconnect backoff, and the
 * rpc()/respondToEngine() request surfaces. Owns the transport fields on the
 * shared state object (ws, events, transport, pending, rpcId, wsFallbackTimer).
 */
export function createTransport({
  state,
  onMessage,
  setStatus,
  onAuthCheck,
  onSseDisrupted,
  onProjectVisibility,
  translate,
  mutations,
}) {
  let transportReconnectTimer = null,
    transportReconnectAttempt = 0;
  function deliver(message) {
    try {
      onMessage(message);
    } catch (error) {
      reportDiagnostic("transport.receiver", error);
    }
  }
  function transportSwitchError() {
    const error = Object.assign(new Error("Bridge transport changed"), { silentTransportSwitch: true });
    return error;
  }
  function clearWsFallbackTimer() {
    clearTimeout(state.wsFallbackTimer);
    mutations.set("wsFallbackTimer", null);
  }
  function clearTransportReconnectTimer() {
    clearTimeout(transportReconnectTimer);
    transportReconnectTimer = null;
  }
  function scheduleTransportReconnect() {
    if (transportReconnectTimer || state.ws || state.events) return;
    const delay =
      TRANSPORT_RECONNECT_DELAYS[Math.min(transportReconnectAttempt++, TRANSPORT_RECONNECT_DELAYS.length - 1)];
    transportReconnectTimer = setTimeout(() => {
      transportReconnectTimer = null;
      if (state.ws || state.events) return;
      mutations.set("transport", "connecting");
      connect();
    }, delay);
  }
  function rejectWebSocketPending() {
    for (const pending of state.pending.values()) pending.reject(transportSwitchError());
    mutations.collection("pending").clear();
  }
  async function postBridge(path, payload, signal) {
    const body = JSON.stringify(payload);
    const connectionError = (cause) =>
      Object.assign(
        new TypeError(translate("errors.bridgeConnectionInterrupted"), {
          cause,
        }),
        { code: "bridge_network_error", operation: payload.method || path },
      );
    let response;
    try {
      response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        cache: "no-store",
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw connectionError(cause);
    }
    let data;
    try {
      data = await response.json();
    } catch (cause) {
      if (signal?.aborted) throw cause;
      if (!response.ok) data = {};
      else if (cause instanceof TypeError) throw connectionError(cause);
      else
        throw Object.assign(new Error(translate("errors.bridgeInvalidResponse"), { cause }), {
          code: "bridge_invalid_response",
          operation: payload.method || path,
          deliveryUncertain: true,
        });
    }
    if (!response.ok) {
      if (response.status === 401) onAuthCheck();
      throw Object.assign(createBridgeError(errorText(data, translate), data?.code), {
        status: response.status,
        operation: payload.method || path,
        deliveryUncertain: response.status >= 500,
      });
    }
    return data;
  }
  function connectSse() {
    if (state.events) return;
    mutations.set("transport", "sse");
    mutations.set("connected", false);
    setStatus("connecting", "common.connectingToCodex");
    let events;
    try {
      events = new EventSource("/api/events?protocol=engine-v1");
    } catch {
      mutations.set("transport", "connecting");
      scheduleTransportReconnect();
      return;
    }
    mutations.set("events", events);
    events.onopen = () => {
      if (state.events !== events) return;
      transportReconnectAttempt = 0;
      setStatus("connecting", "common.connectingToCodex");
    };
    events.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "auth/required") {
          onAuthCheck();
          return;
        }
        deliver(message);
      } catch (error) {
        reportDiagnostic("transport.sse-payload", error);
      }
    };
    events.onerror = () => {
      onAuthCheck();
      if (state.events !== events) return;
      mutations.set("connected", false);
      setStatus("connecting", "common.connectingToCodex");
      onSseDisrupted();
      if (events.readyState === EventSource.CLOSED) {
        events.close();
        mutations.set("events", null);
        mutations.set("transport", "connecting");
        scheduleTransportReconnect();
      }
    };
  }
  function fallbackToSse(ws) {
    if (state.transport === "sse" || (ws && state.ws !== ws)) return;
    clearWsFallbackTimer();
    rejectWebSocketPending();
    mutations.set("connected", false);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    mutations.set("ws", null);
    connectSse();
  }
  function connect() {
    if (state.events || state.ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`, "panda-engine-v1");
    } catch {
      fallbackToSse();
      return;
    }
    mutations.set("transport", "ws");
    mutations.set("ws", ws);
    const fallback = () => {
      onAuthCheck();
      fallbackToSse(ws);
    };
    mutations.set("wsFallbackTimer", setTimeout(fallback, WS_CONNECT_TIMEOUT_MS));
    ws.onopen = () => {
      if (state.ws === ws) setStatus("connecting", "common.connectingToCodex");
    };
    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
      try {
        const message = JSON.parse(event.data);
        clearWsFallbackTimer();
        deliver(message);
      } catch (error) {
        reportDiagnostic("transport.ws-payload", error);
        fallback();
      }
    };
    ws.onerror = fallback;
    ws.onclose = fallback;
  }
  function rpc(method, params = {}) {
    const id = mutations.update("rpcId", (value) => value + 1, true);
    const operationId = crypto.randomUUID();
    const timeoutError = () =>
      Object.assign(new Error(translate("errors.engineRequestTimedOut", { operation: method })), {
        code: "bridge_timeout",
        operation: method,
      });
    if (state.transport === "sse") {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
      const request = async () => {
        const payload = { id, operationId, method, params };
        try {
          return await postBridge("/api/rpc", payload, controller.signal);
        } catch (error) {
          const repeatable =
            RETRYABLE_READS.has(method) || (method === "thread/resume" && params.pandaPrepareInput === true);
          if (errorCode(error) !== "bridge_network_error" || !repeatable || controller.signal.aborted) throw error;
          return postBridge("/api/rpc", payload, controller.signal);
        }
      };
      return request()
        .then((message) => {
          if (message.type !== "rpc/result")
            throw createBridgeError(message.error || translate("errors.bridgeRequestFailed"), message.code);
          if (message.projectVisibility) onProjectVisibility(message.projectVisibility);
          return message.result;
        })
        .catch((error) => {
          throw controller.signal.aborted ? timeoutError() : error;
        })
        .finally(() => clearTimeout(timer));
    }
    if (state.ws?.readyState === WebSocket.OPEN) {
      const ws = state.ws;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mutations.collection("pending").delete(id);
          reject(timeoutError());
          // Reconnect future calls without replaying this one: turn/start,
          // turn/steer and queue additions may already have been accepted.
          fallbackToSse(ws);
        }, RPC_TIMEOUT_MS);
        mutations.collection("pending").set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          ws.send(JSON.stringify({ type: "rpc", id, operationId, method, params }));
        } catch {
          fallbackToSse(ws);
        }
      });
    }
    return Promise.reject(transportSwitchError());
  }
  function respondToEngine(requestId, result, error) {
    const id = mutations.update("rpcId", (value) => value + 1, true);
    if (state.transport === "sse")
      return fetch("/api/engine/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, requestId, result, error }),
        cache: "no-store",
      }).then(async (response) => {
        const message = await response.json().catch(() => ({}));
        if (!response.ok || message.type === "rpc/error")
          throw createBridgeError(message.error || translate("errors.couldNotSubmitAnswer"), message.code);
        return message;
      });
    if (state.ws?.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          mutations.collection("pending").delete(id);
          reject(new Error(translate("errors.couldNotSubmitAnswer")));
        }, RESPOND_TIMEOUT_MS);
        mutations.collection("pending").set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (failure) => {
            clearTimeout(timer);
            reject(failure);
          },
        });
        try {
          state.ws.send(
            JSON.stringify(
              error
                ? { type: "engine/error", id, requestId, error }
                : { type: "engine/response", id, requestId, result },
            ),
          );
        } catch (failure) {
          mutations.collection("pending").delete(id);
          clearTimeout(timer);
          fallbackToSse(state.ws);
          reject(failure);
        }
      });
    }
    return Promise.reject(transportSwitchError());
  }
  return {
    connect,
    rpc,
    respondToEngine,
    postBridge,
    clearTransportReconnectTimer,
    resetReconnectBackoff() {
      transportReconnectAttempt = 0;
    },
  };
}
