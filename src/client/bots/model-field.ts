import type { Translate } from "../../shared/i18n/messages.js";
import type { SettingsModelCatalog } from "../settings-pages/contracts.js";
import { messageHtml, localizeText, setOpaqueText } from "../i18n.js";
import { escapeHtml } from "../../shared/html.js";

/** Catalog completion updates only the model field, preserving the Bot form's edit buffer. */
export function createBotModelField(t: Translate, catalog?: SettingsModelCatalog) {
  let element: HTMLElement | null = null,
    epoch = 0,
    loading = false,
    retained = "";
  function close() {
    epoch++;
    element = null;
    loading = false;
  }
  function update(pending: boolean, failed = false) {
    if (!element) return;
    const select = element.querySelector<HTMLSelectElement>("select")!,
      selected = select.value,
      models = catalog?.read().models ?? [];
    const option = (value: string, label: string) => {
      const item = document.createElement("option");
      item.value = value;
      if (value === "") localizeText(item, "cli.botDefaultModel", {}, t);
      else item.textContent = label;
      return item;
    };
    const missing = !!selected && !models.some((model) => model.id === selected);
    select.replaceChildren(
      option("", t("cli.botDefaultModel")),
      ...models.map((model) => option(model.id, model.label)),
      ...(missing ? [option(selected, selected)] : []),
    );
    select.value = selected;
    select.setCustomValidity(
      missing && selected !== retained && !failed && !pending ? t("cli.botModelUnavailable") : "",
    );
    select.setAttribute("aria-busy", String(pending));
    const status = element.querySelector<HTMLElement>("[data-bot-model-status]")!,
      retry = element.querySelector<HTMLButtonElement>("[data-bot-model-retry]")!;
    const statusId = pending
      ? "common.loadingModels"
      : failed
        ? "errors.couldNotLoadModels"
        : missing
          ? "cli.botModelUnavailable"
          : null;
    if (statusId) localizeText(status, statusId, {}, t);
    else setOpaqueText(status, "");
    status.hidden = !status.textContent;
    retry.hidden = !failed;
    retry.disabled = pending;
  }
  async function load() {
    if (loading || !element) return;
    const current = epoch;
    loading = true;
    update(true);
    let ready: boolean;
    try {
      ready = (await catalog?.load()) === true;
    } catch {
      ready = false;
    }
    if (current !== epoch || !element) return;
    loading = false;
    update(false, !ready);
  }
  return {
    html: () =>
      `<div data-bot-model-field><label class="wb-field"><span>${messageHtml("cli.botModel", {}, t)}</span><select name="pf-bot-model" aria-describedby="botModelStatus"><option value="">${escapeHtml(t("cli.botDefaultModel"))}</option></select></label><p id="botModelStatus" data-bot-model-status role="status" hidden></p><button class="wb-button" type="button" data-bot-model-retry hidden>${messageHtml("sessions.retryLoadingModels", {}, t)}</button></div>`,
    mount(host: HTMLElement, initial = "") {
      close();
      element = host.querySelector("[data-bot-model-field]");
      if (!element) return;
      retained = initial;
      const select = element.querySelector<HTMLSelectElement>("select")!;
      if (initial) {
        const option = document.createElement("option");
        option.value = initial;
        option.textContent = initial;
        select.append(option);
        select.value = initial;
      }
      element.querySelector<HTMLSelectElement>("select")!.onchange = () => update(false);
      element.querySelector<HTMLButtonElement>("[data-bot-model-retry]")!.onclick = () => void load();
      update(false);
      if (!catalog?.read().models.length) void load();
    },
    close,
  };
}
