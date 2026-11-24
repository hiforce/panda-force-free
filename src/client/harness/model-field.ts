import { reasoningLabel } from "./reasoning-label.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { HarnessCatalog, HarnessRuntimeView } from "../../shared/harness/contracts.js";
import type { RuntimeSelection } from "../../shared/engine/runtime-selection.js";
import { changeRuntimeSelection, defaultRuntimeModel } from "../../shared/engine/runtime-selection.js";
import { messageHtml, localizeText, setOpaqueText } from "../i18n.js";
import { runtimeModelCatalog } from "./model-catalog.js";
import { mountReasoningSlider } from "../session-controls/reasoning-slider.js";

/** A form owns its selection; late discovery never replaces another runtime's catalog or draft. */
export function createRuntimeModelField(
  t: Translate,
  prefix: string,
  changed: () => void = () => {},
  conversation = false,
) {
  const catalog = runtimeModelCatalog(t, conversation);
  let host: HTMLElement | null = null,
    epoch = 0,
    pending = false,
    locked = false,
    selection: RuntimeSelection = { runtimeId: "", model: "", effort: "" },
    retained: RuntimeSelection = { ...selection },
    list: HarnessCatalog | null = null,
    runtime: HarnessRuntimeView | null = null,
    failed = false;
  const control = (name: string) => host!.querySelector<HTMLSelectElement>(`[name="${prefix}-${name}"]`)!;
  function options(
    select: HTMLSelectElement,
    values: Array<{ id: string; label: string; message?: MessageId }>,
    current: string,
  ) {
    select.replaceChildren(
      ...values.map((value) => {
        const option = document.createElement("option");
        option.value = value.id;
        if (value.message) localizeText(option, value.message, {}, t);
        else option.textContent = value.label;
        return option;
      }),
    );
    select.value = current;
  }
  function render() {
    if (!host) return;
    const runtimes = list?.runtimes.filter((entry) => entry.enabled) ?? [],
      runtimeMissing = !!selection.runtimeId && !runtimes.some((entry) => entry.id === selection.runtimeId),
      models = runtime?.id === selection.runtimeId ? catalog.models(runtime) : [],
      model = models.find((entry) => entry.id === selection.model),
      effectiveModel =
        model ??
        (!selection.model && runtime ? models.find((entry) => entry.id === defaultRuntimeModel(runtime!)) : undefined),
      efforts = effectiveModel?.efforts ?? [],
      modelMissing = !!selection.model && !model,
      effortMissing = !!selection.effort && !efforts.some((entry) => entry.id === selection.effort);
    options(
      control("runtime"),
      [
        ...runtimes.map((entry) => ({ id: entry.id, label: entry.name })),
        ...(runtimeMissing ? [{ id: selection.runtimeId, label: selection.runtimeId }] : []),
      ],
      selection.runtimeId,
    );
    options(
      control("model"),
      [
        { id: "", label: t("harness.automatic"), message: "harness.automatic" },
        ...models,
        ...(modelMissing ? [{ id: selection.model, label: selection.model }] : []),
      ],
      selection.model,
    );
    const effort = host.querySelector<HTMLInputElement>(`[name="${prefix}-effort"]`)!;
    const effortField = host.querySelector<HTMLElement>("[data-runtime-effort-slider]")!;
    effort.value = selection.effort;
    mountReasoningSlider(
      effortField,
      [
        { id: "", label: t("harness.automatic") },
        ...efforts,
        ...(effortMissing ? [{ id: selection.effort, label: reasoningLabel(selection.effort, t) }] : []),
      ],
      selection.effort,
      t("common.reasoningEffort"),
      (value) => {
        selection.effort = effort.value = value;
        changed();
      },
      locked || pending || !runtime,
    );
    for (const name of ["runtime", "model"]) control(name).setAttribute("aria-busy", String(pending));
    effortField.setAttribute("aria-busy", String(pending));
    control("runtime").disabled = locked;
    control("model").disabled = locked || pending || !runtime;
    control("runtime").setCustomValidity(
      !pending && (!selection.runtimeId || runtimeMissing) && selection.runtimeId !== retained.runtimeId
        ? t("harness.empty")
        : "",
    );
    const status = host.querySelector<HTMLElement>("[data-runtime-status]")!,
      retry = host.querySelector<HTMLButtonElement>("[data-runtime-retry]")!,
      hint = host.querySelector<HTMLElement>("[data-runtime-hint]")!;
    const statusId = pending
      ? "common.loadingModels"
      : failed
        ? "harness.errorUnavailable"
        : runtimeMissing || modelMissing || effortMissing
          ? "harness.selectionUnavailable"
          : null;
    if (statusId) localizeText(status, statusId, {}, t);
    else setOpaqueText(status, "");
    status.hidden = !statusId;
    retry.hidden = !failed;
    retry.disabled = pending;
    localizeText(hint, "harness.selectionHint", {}, t);
  }
  async function load(reloadList = false) {
    const current = ++epoch;
    pending = true;
    failed = false;
    render();
    try {
      if (!list || reloadList) {
        const value = await catalog.list();
        if (!host || current !== epoch) return;
        list = value;
        if (!selection.runtimeId) selection.runtimeId = list.defaultRuntimeId;
        render();
      }
      const value = await catalog.discover(selection.runtimeId);
      if (!host || current !== epoch) return;
      runtime = value;
    } catch {
      if (current === epoch) failed = true;
    } finally {
      if (host && current === epoch) {
        pending = false;
        render();
        changed();
      }
    }
  }
  return {
    html: () =>
      `<div data-runtime-model-field class="wb-form"><label class="wb-field"><span>${messageHtml("harness.title", {}, t)}</span><select name="${prefix}-runtime" required></select></label><label class="wb-field"><span>${messageHtml("common.model", {}, t)}</span><select name="${prefix}-model"></select></label><div class="wb-field"><input type="hidden" name="${prefix}-effort"><div data-runtime-effort-slider></div><small data-runtime-hint></small></div><p data-runtime-status data-bot-model-status role="status" hidden></p><button class="wb-button" type="button" data-runtime-retry data-bot-model-retry hidden>${messageHtml("sessions.retryLoadingModels", {}, t)}</button></div>`,
    mount(parent: HTMLElement, initial?: Partial<RuntimeSelection>) {
      epoch++;
      host = parent.querySelector("[data-runtime-model-field]");
      selection = { runtimeId: initial?.runtimeId ?? "", model: initial?.model ?? "", effort: initial?.effort ?? "" };
      retained = { ...selection };
      list = null;
      runtime = null;
      if (!host) return;
      control("runtime").onchange = () => {
        const id = control("runtime").value,
          target = list?.runtimes.find((entry) => entry.id === id);
        if (!target) return;
        selection = changeRuntimeSelection(selection, target);
        runtime = null;
        changed();
        void load();
      };
      control("model").onchange = () => {
        selection = changeRuntimeSelection(selection, runtime!, control("model").value);
        render();
        changed();
      };
      host.querySelector<HTMLButtonElement>("[data-runtime-retry]")!.onclick = () => void load(true);
      return load();
    },
    read() {
      return { ...selection };
    },
    runtime() {
      return runtime;
    },
    setLocked(value: boolean) {
      if (locked === value) return;
      locked = value;
      render();
    },
    ready: () => !pending && !failed && !!runtime,
    close() {
      epoch++;
      host = null;
    },
  };
}
