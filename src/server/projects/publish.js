import { reportDiagnostic } from "../../shared/diagnostics.js";
import { isMetadataPending } from "../../shared/async-value.js";
const pending = new Set();
/** Metadata publication must never turn an accepted native mutation into a rejected one. */
export function publishCatalogUpdate(catalog, broadcast, update) {
  const publish = (snapshot) => {
    if (snapshot) broadcast({ type: "project-catalog/changed", ...snapshot });
  };
  try {
    const result = update(catalog);
    if (!isMetadataPending(result)) {
      publish(result);
      return;
    }
    const operation = Promise.resolve(result)
      .then(publish)
      .catch((error) => reportDiagnostic("projects.publish", error))
      .finally(() => pending.delete(operation));
    pending.add(operation);
    return operation;
  } catch (error) {
    reportDiagnostic("projects.publish", error);
  }
}
/** Stop the engine first so no new catalog publication can race pool closure. */
export async function drainCatalogUpdates() {
  while (pending.size) await Promise.all([...pending]);
}
