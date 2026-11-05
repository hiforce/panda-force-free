
import { createBridgeError } from "../shared/bridge-errors.js";

const WS_CONNECT_TIMEOUT_MS = 2500;
const TRANSPORT_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const RESPOND_TIMEOUT_MS = 15000;
// Allow the server's 30-second native RPC deadline to report its own error,
// while bounding the wait if an acknowledgement is lost in either transport.
const RPC_TIMEOUT_MS = 45000;

/**
 * Bridge transport: WebSocket with SSE fallback, reconnect backoff, and the
 * rpc()/respondToCodex() request surfaces. Owns the transport fields on the
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
}) {
  let transportReconnectTimer = null,
    transportReconnectAttempt = 0;

  function transportSwitchError() {
    const error = new Error("Bridge transport changed");
    error.silentTransportSwitch = true;
    return error;
  }
  function clearWsFallbackTimer() {
    clearTimeout(state.wsFallbackTimer);
    state.wsFallbackTimer = null;
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
      state.transport = "connecting";
      connect();
    }, delay);
  }
  function rejectWebSocketPending() {
    for (const pending of state.pending.values()) pending.reject(transportSwitchError());
    state.pending.clear();
  }
  async function postBridge(path, payload, signal) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal,
      }),
      data = await response.json().catch(() => ({}));
    if (!response.ok) throw createBridgeError(data.error || "Codex bridge request failed", data.code);
    return data;
  }
  function connectSse() {
    if (state.events) return;
    state.transport = "sse";
    state.connected = false;
    setStatus("connecting", "common.connectingToCodex");
    let events;
    try {
      events = new EventSource("/api/events");
    } catch {
      state.transport = "connecting";
      scheduleTransportReconnect();
      return;
    }
    state.events = events;
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
        onMessage(message);
      } catch {}
    };
    events.onerror = () => {
      onAuthCheck();
      if (state.events !== events) return;
      state.connected = false;
      setStatus("connecting", "common.connectingToCodex");
      onSseDisrupted();
      if (events.readyState === EventSource.CLOSED) {
        events.close();
        state.events = null;
        state.transport = "connecting";
        scheduleTransportReconnect();
      }
    };
  }
  function fallbackToSse(ws) {
    if (state.transport === "sse" || (ws && state.ws !== ws)) return;
    clearWsFallbackTimer();
    rejectWebSocketPending();
    state.connected = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    state.ws = null;
    connectSse();
  }
  function connect() {
    if (state.events || state.ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      fallbackToSse();
      return;
    }
    state.transport = "ws";
    state.ws = ws;
    const fallback = () => {
      onAuthCheck();
      fallbackToSse(ws);
    };
    state.wsFallbackTimer = setTimeout(fallback, WS_CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (state.ws === ws) setStatus("connecting", "common.connectingToCodex");
    };
    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
      try {
        const message = JSON.parse(event.data);
        clearWsFallbackTimer();
        onMessage(message);
      } catch {
        fallback();
      }
    };
    ws.onerror = fallback;
    ws.onclose = fallback;
  }
  function rpc(method, params = {}) {
    const id = state.rpcId++;
    const timeoutError = () => new Error(`Codex bridge request timed out: ${method}`);
    if (state.transport === "sse") {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
      return postBridge("/api/rpc", { id, method, params }, controller.signal)
        .then((message) => {
          if (message.type !== "rpc/result")
            throw createBridgeError(message.error || "Codex bridge request failed", message.code);
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
          state.pending.delete(id);
          reject(timeoutError());
          // Reconnect future calls without replaying this one: turn/start,
          // turn/steer and queue additions may already have been accepted.
          fallbackToSse(ws);
        }, RPC_TIMEOUT_MS);
        state.pending.set(id, {
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
          ws.send(JSON.stringify({ type: "rpc", id, method, params }));
        } catch {
          fallbackToSse(ws);
        }
      });
    }
    return Promise.reject(transportSwitchError());
  }
  function respondToCodex(requestId, result, error) {
    const id = state.rpcId++;
    if (state.transport === "sse")
      return fetch("/api/codex/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, requestId, result, error }),
        cache: "no-store",
      }).then(async (response) => {
        const message = await response.json().catch(() => ({}));
        if (!response.ok || message.type === "rpc/error")
          throw createBridgeError(message.error || "Could not submit answer", message.code);
        return message;
      });
    if (state.ws?.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(id);
          reject(new Error(translate("errors.couldNotSubmitAnswer")));
        }, RESPOND_TIMEOUT_MS);
        state.pending.set(id, {
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
              error ? { type: "codex/error", id, requestId, error } : { type: "codex/response", id, requestId, result },
            ),
          );
        } catch (failure) {
          state.pending.delete(id);
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
    respondToCodex,
    postBridge,
    clearTransportReconnectTimer,
    resetReconnectBackoff() {
      transportReconnectAttempt = 0;
    },
  };
}
