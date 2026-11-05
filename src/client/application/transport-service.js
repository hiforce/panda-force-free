import { createTransport } from "../transport.js";

// Transport produces envelopes; the application attaches one router after assembly.
export function assembleTransport({ legacyState, t }) {
  let router = null;
  const transport = createTransport({
    state: legacyState,
    onMessage: (message) => router.envelope(message),
    setStatus: (kind, text) => router.status(kind, text),
    onAuthCheck: () => globalThis.__pandaForceCheckAuth?.(),
    onSseDisrupted: () => router.disrupted(),
    onProjectVisibility: (snapshot) => router.envelope({ ...snapshot, type: "projects/visibility" }),
    translate: (message) => t(message),
  });
  return {
    connect: transport.connect,
    rpc: transport.rpc,
    postBridge: transport.postBridge,
    respondToCodex: transport.respondToCodex,
    clearTransportReconnectTimer: transport.clearTransportReconnectTimer,
    resetReconnectBackoff: transport.resetReconnectBackoff,
    attach(handlers) {
      if (router) throw new Error("Transport router already attached");
      router = Object.freeze({ ...handlers });
    },
  };
}
