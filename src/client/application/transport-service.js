import { checkAuthentication } from "../http-client.js";
import { createTransport } from "../transport.js";
// Transport produces envelopes; the application attaches one router after assembly.
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "t", never, "transport">} options */
export function assembleTransport({ t, state, mutations }) {
  let router = null;
  const transport = createTransport({
    onMessage: (message) => router.envelope(message),
    setStatus: (kind, text) => router.status(kind, text),
    onAuthCheck: () => checkAuthentication(),
    onSseDisrupted: () => router.disrupted(),
    onProjectVisibility: (snapshot) => router.envelope({ ...snapshot, type: "projects/visibility" }),
    translate: (message, values) => t(message, values),
    state,
    mutations,
  });
  return {
    connect: transport.connect,
    rpc: transport.rpc,
    postBridge: transport.postBridge,
    respondToEngine: transport.respondToEngine,
    clearTransportReconnectTimer: transport.clearTransportReconnectTimer,
    resetReconnectBackoff: transport.resetReconnectBackoff,
    attach(handlers) {
      if (router) throw new Error("Transport router already attached");
      router = Object.freeze({ ...handlers });
    },
  };
}
