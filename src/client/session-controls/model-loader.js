import { filterAppModels } from "../ui-core.js";
import { createBridgeError } from "../../shared/bridge-errors.js";

/** One catalog request owns its retries; concurrent views join the same promise. */
export function createModelCatalogLoader({
  request,
  setStatus,
  changed,
  accept,
  failed,
  context = () => "",
  contextChanged = () => {},
}) {
  let pending = null,
    pendingContext = "",
    generation = 0,
    activeController = null;
  return function loadModels({ timeoutMs = 8000, attempts = 3, retryDelayMs = 500 } = {}) {
    const scope = context();
    if (pending && pendingContext === scope) return pending;
    if (scope !== pendingContext) contextChanged();
    activeController?.abort();
    const current = ++generation;
    pendingContext = scope;
    setStatus("loading");
    changed();
    pending = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), timeoutMs);
        activeController = controller;
        try {
          const message = await request(controller.signal);
          if (current !== generation || context() !== scope) return false;
          if (message.type !== "rpc/result")
            throw createBridgeError(message.error || "Could not load models", message.code);
          const models = filterAppModels(message.result?.data || []);
          if (!models.length) throw new Error("No models available");
          accept(models);
          return true;
        } catch (error) {
          if (current !== generation || context() !== scope) return false;
          lastError = controller.signal.aborted
            ? Object.assign(new Error("Model catalog request timed out", { cause: error }), {
                code: "model_catalog_timeout",
              })
            : error;
          if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      setStatus("error");
      changed();
      failed(lastError);
      return false;
    })().finally(() => {
      if (current === generation) {
        pending = null;
        activeController = null;
      }
    });
    return pending;
  };
}
