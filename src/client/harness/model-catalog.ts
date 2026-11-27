import { reasoningLabel } from "./reasoning-label.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { HarnessCatalog, HarnessRuntimeView } from "../../shared/harness/contracts.js";
import { runtimeModels } from "../../shared/engine/runtime-selection.js";
import { harnessApi } from "./api.js";

/** Catalog requests are independent of the active session and its model RPC interceptor. */
export type RuntimeModelCatalogScope = boolean | "bots" | "creation" | "project-memory";

export function runtimeModelCatalog(t: Translate, scope: RuntimeModelCatalogScope = false) {
  const api = harnessApi(t);
  const scopeParam = typeof scope === "string" ? `scope=${scope}` : scope ? "scope=conversation" : "";
  return {
    list: () => api<HarnessCatalog>(scopeParam ? `/api/model-catalog?${scopeParam}` : "/api/model-catalog"),
    async discover(id: string) {
      return (
        await api<{ runtime: HarnessRuntimeView }>(
          `/api/model-catalog?runtimeId=${encodeURIComponent(id)}${scopeParam ? `&${scopeParam}` : ""}`,
        )
      ).runtime;
    },
    models: (runtime: HarnessRuntimeView) =>
      runtimeModels(runtime).map((model) => ({
        ...model,
        efforts: model.efforts.map((effort) => ({ ...effort, label: reasoningLabel(effort.id, t, effort.label) })),
      })),
  };
}
