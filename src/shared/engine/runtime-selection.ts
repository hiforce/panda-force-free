import type { HarnessRuntimeView } from "../harness/contracts.js";

export interface RuntimeSelection {
  runtimeId: string;
  model: string;
  effort: string;
}

export function supportedEffort(values: readonly string[], preferred = "", defaultEffort = "") {
  return values.includes(preferred) ? preferred : values.includes(defaultEffort) ? defaultEffort : (values[0] ?? "");
}

/** One capability projection for runtime settings, session controls and application forms. */
export function runtimeModels(runtime: HarnessRuntimeView) {
  return runtime.models.map((model) => ({
    id: model.id,
    label: model.name,
    defaultEffort:
      runtime.defaultModel === model.id && runtime.defaultEffort ? runtime.defaultEffort : (model.defaultEffort ?? ""),
    efforts: model.efforts.map((effort) => ({ id: effort.id, label: effort.name })),
  }));
}

export function defaultRuntimeModel(runtime: HarnessRuntimeView) {
  const defaults = runtime.models.filter((model) => model.isDefault);
  return runtime.defaultModel || (defaults.length === 1 ? defaults[0]!.id : "");
}

export function runtimeModelCatalog(runtime: HarnessRuntimeView) {
  return {
    data: runtimeModels(runtime).map((model) => ({
      id: model.id,
      model: model.id,
      displayName: model.label,
      isDefault: model.id === defaultRuntimeModel(runtime),
      defaultReasoningEffort: model.defaultEffort || null,
      supportedReasoningEfforts: model.efforts.map((effort) => ({
        reasoningEffort: effort.id,
        description: effort.label,
      })),
    })),
    nextCursor: null,
  };
}

/** Explicit runtime changes clear vendor-specific choices; model changes only retain supported effort. */
export function changeRuntimeSelection(previous: RuntimeSelection, runtime: HarnessRuntimeView, model?: string) {
  const runtimeChanged = previous.runtimeId !== runtime.id,
    modelId = runtimeChanged ? "" : (model ?? previous.model),
    selected = runtimeModels(runtime).find((entry) => entry.id === modelId);
  return {
    runtimeId: runtime.id,
    model: modelId,
    effort: !runtimeChanged && selected?.efforts.some((entry) => entry.id === previous.effort) ? previous.effort : "",
  };
}
