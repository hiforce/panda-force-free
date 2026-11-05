import type { ConfigurationReadiness } from "../contracts/platform.js";
// Startup owns the initial configuration task; navigation only observes it.
export function createConfigurationReadiness(): ConfigurationReadiness {
  let ready = Promise.resolve();
  return Object.freeze({
    get ready() {
      return ready;
    },
    start(promise: Promise<void>) {
      ready = promise;
    },
  });
}
