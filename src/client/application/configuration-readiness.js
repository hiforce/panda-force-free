// Startup owns the initial configuration task; navigation only observes it.
export function createConfigurationReadiness() {
  let ready = Promise.resolve();
  return Object.freeze({
    get ready() {
      return ready;
    },
    start(promise) {
      ready = promise;
    },
  });
}
