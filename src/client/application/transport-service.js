import { createHarnessBrowserBoundary } from "../harness/boundary.js";
import { checkAuthentication } from "../http-client.js";
import { createTransport } from "../transport.js";
// Transport produces envelopes; the application attaches one router after assembly.
/** @param {import("./ports.js").FeatureOptions<"state" | "mutations" | "t", never, "transport">} options */
export function assembleTransport({ t, state, mutations }) {
  let router = null;
  const harness = createHarnessBrowserBoundary();
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
    rpc: (method, params) => harness.rpc(method, params, transport.rpc),
    postBridge: (path, payload, signal) =>
      harness.post(path, payload, () => transport.postBridge(path, payload, signal)),
    attachHarness: harness.attach,
    syncHarnessRoute: harness.syncRoute,
    harnessControls: harness.controls,
    applyHarnessPermission: harness.applyPermission,
    applyHarnessRuntime: harness.applyRuntime,
    harnessAvailable: harness.available,
    harnessManaged: harness.managed,
    harnessContext: harness.context,
    respondToEngine: transport.respondToEngine,
    clearTransportReconnectTimer: transport.clearTransportReconnectTimer,
    resetReconnectBackoff: transport.resetReconnectBackoff,
    attach(handlers) {
      if (router) throw new Error("Transport router already attached");
      router = Object.freeze({ ...handlers });
    },
  };
}
