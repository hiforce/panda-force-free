import { reportDiagnostic } from "../../shared/diagnostics.js";

/** Metadata publication must never turn an accepted native mutation into a rejected one. */
export function publishCatalogUpdate(catalog, broadcast, update) {
  try {
    const snapshot = update(catalog);
    if (snapshot) broadcast({ type: "project-catalog/changed", ...snapshot });
  } catch (error) {
    reportDiagnostic("projects.publish", error);
  }
}
