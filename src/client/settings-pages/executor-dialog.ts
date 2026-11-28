import { executorCredentialTarget, executorKinds } from "../../shared/creation/media-executors.js";
import type {
  CreationMediaExecutor,
  CreationMediaKind,
  CreationMediaPreset,
  ExecutorCategory,
} from "../../shared/creation/media-executors.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { harnessApi } from "../harness/api.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { categoryIcons, categoryLabels, executorCategory, executorEndpoint, providerName } from "./executor-catalog.js";
import type { ExecutorCatalog } from "./executor-catalog.js";
import type { ExecutorBrand } from "./executor-brands.js";
import { createExecutorCredentialDialog } from "./executor-credential-dialog.js";
import { createExecutorPicker } from "./executor-picker.js";
import { createMediaCliSettings } from "./media-cli.js";

interface EditorOptions {
  catalog: ExecutorCatalog;
  category?: ExecutorCategory;
  kind?: CreationMediaKind;
  existing?: CreationMediaExecutor;
  saved(executor: CreationMediaExecutor): Promise<void>;
  focusFallback?(): HTMLElement | undefined;
}

function option(value: string, label: string) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

export function createExecutorDialog(t: Translate, reload: () => Promise<ExecutorCatalog | undefined>) {
  const api = harnessApi(t);
  const dialog = document.createElement("dialog");
  dialog.className = "session-dialog executor-dialog";
  dialog.setAttribute("aria-labelledby", "executor-dialog-title");
  let trigger: HTMLElement | undefined;
  let focusFallback: EditorOptions["focusFallback"];
  let controller: AbortController | undefined;
  let busy = false;
  let updateCatalog: ((value: ExecutorCatalog) => void) | undefined;

  const credentialEditor = createExecutorCredentialDialog(t);
  const cli = createMediaCliSettings(t, async () => {
    const current = await reload();
    if (current && dialog.open) updateCatalog?.(current);
  });
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    controller?.abort();
    credentialEditor.close();
    cli.hide();
    dialog.querySelector("form")?.reset();
    dialog.remove();
    dialog.replaceChildren();
    (trigger?.isConnected ? trigger : focusFallback?.())?.focus();
    trigger = undefined;
    focusFallback = undefined;
    updateCatalog = undefined;
    busy = false;
  });

  function open(opener: HTMLElement, options: EditorOptions) {
    if (dialog.open || !opener.isConnected || options.catalog.configured === false) return;
    let catalog = options.catalog;
    const { existing, kind } = options;
    const original = catalog.presets.find((item) => item.id === existing?.preset);
    if (existing && !original) return;
    let category = existing ? executorCategory(existing.kind, original) : (kind ?? options.category ?? "image");
    const categories: readonly ExecutorCategory[] = kind ? [kind, "cli"] : [...executorKinds, "cli"];
    const id = existing?.id ?? crypto.randomUUID();
    trigger = opener;
    focusFallback = options.focusFallback;
    controller = new AbortController();
    const signal = controller.signal;
    setMessageHtml(
      dialog,
      `
      <header class="session-dialog-heading executor-dialog-heading">
        <div>
          <h2 id="executor-dialog-title">${messageHtml(existing ? "creation.executorEdit" : "creation.mediaAddExecutor", {}, t)}</h2>
          <p>${messageHtml("creation.executorDialogHelp", {}, t)}</p>
        </div>
      </header>
      <form class="session-dialog-form wb-form">
        <div class="session-dialog-body executor-dialog-body">
          <fieldset class="executor-category-picker"${existing ? " hidden" : ""}>
            <legend>${messageHtml("creation.executorCategory", {}, t)}</legend>
            <div class="executor-category-choices">
              ${categories
                .map(
                  (item) => `
                <label class="executor-choice">
                  <input type="radio" name="category" value="${item}">
                  <span>${codexIcon(categoryIcons[item])}${messageHtml(categoryLabels[item], {}, t)}</span>
                </label>`,
                )
                .join("")}
            </div>
          </fieldset>
          <div class="executor-config-fields" data-executor-options hidden>
            <div class="wb-field" data-executor-provider-field><span></span><select name="provider" required></select></div>
            <label class="wb-field"><span>${messageHtml("creation.mediaModel", {}, t)}</span><select name="model" required></select></label>
          </div>
          <p data-executor-unavailable class="executor-form-notice" role="status" hidden></p>
          <p data-executor-use class="executor-form-notice" hidden>${messageHtml("creation.executorConfigOnly", {}, t)}</p>
          <section class="media-cli-registrations" data-executor-cli hidden></section>
          <div class="executor-credentials" data-executor-credentials hidden>
            <label class="wb-field"><span>${messageHtml("creation.credentialSettings", {}, t)}</span><select name="credentialId" required></select></label>
            <button class="wb-button executor-add-credential" type="button" data-add-credential>${codexIcon("plus")}${messageHtml("creation.credentialAdd", {}, t)}</button>
            <details class="executor-advanced">
              <summary>${messageHtml("creation.executorAdvanced", {}, t)}</summary>
              <label class="wb-field"><span>${messageHtml("creation.mediaName", {}, t)}</span><input name="displayName" maxlength="80"></label>
            </details>
          </div>
          <p class="executor-form-notice" role="status" data-media-config-status hidden></p>
        </div>
        <footer class="session-dialog-actions">
          <button type="button" class="session-button" data-media-dismiss>${messageHtml("common.cancel", {}, t)}</button>
          <button type="submit" class="session-button primary">${messageHtml("creation.mediaTestSave", {}, t)}</button>
        </footer>
      </form>`,
    );
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    const provider = form.querySelector<HTMLSelectElement>('[name="provider"]')!;
    const providerPicker = createExecutorPicker(provider);
    signal.addEventListener("abort", providerPicker.close, { once: true });
    const providerBrands = new Map<string, ExecutorBrand>();
    const model = form.querySelector<HTMLSelectElement>('[name="model"]')!;
    const credential = form.querySelector<HTMLSelectElement>('[name="credentialId"]')!;
    const addCredential = form.querySelector<HTMLButtonElement>("[data-add-credential]")!;
    const displayName = form.querySelector<HTMLInputElement>('[name="displayName"]')!;
    const providerLabel = form.querySelector<HTMLElement>("[data-executor-provider-field] span")!;
    const fields = form.querySelector<HTMLElement>("[data-executor-options]")!;

    const credentials = form.querySelector<HTMLElement>("[data-executor-credentials]")!;
    const unavailable = form.querySelector<HTMLElement>("[data-executor-unavailable]")!;
    const registry = form.querySelector<HTMLElement>("[data-executor-cli]")!;
    const useNotice = form.querySelector<HTMLElement>("[data-executor-use]")!;
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const dismiss = form.querySelector<HTMLButtonElement>("[data-media-dismiss]")!;
    const status = form.querySelector<HTMLElement>("[data-media-config-status]")!;
    const controls = [...form.querySelectorAll<HTMLInputElement>('input[name="category"]')];
    const supplier = executorCredentialTarget;
    const canKeepLegacy = !!existing && !existing.credentialId;

    function availablePresets() {
      return catalog.presets.filter(
        (preset) =>
          executorCategory(preset.kind, preset) === category &&
          (!kind || preset.kind === kind) &&
          (!existing || preset.id === existing.preset),
      );
    }

    function selectedPreset() {
      return availablePresets().find(
        (item) => supplier(item) === provider.value && item.models.some((value) => value.id === model.value),
      );
    }

    function syncSubmit() {
      submit.disabled = busy || !selectedPreset() || !credential.value;
    }

    function showCredentials(previous = credential.value) {
      const choices = (catalog.credentials ?? []).filter((item) => item.target === provider.value);
      const placeholder = option(
        "",
        t(choices.length || canKeepLegacy ? "creation.credentialChoose" : "creation.credentialNoOptions"),
      );
      credential.replaceChildren(
        placeholder,
        ...(canKeepLegacy ? [option("legacy", t("creation.credentialKeepLinked"))] : []),
        ...choices.map((item) => option(item.id, item.name)),
      );
      if ([...credential.options].some((item) => item.value && item.value === previous)) credential.value = previous;
      else if (!existing && choices.length === 1) credential.value = choices[0]!.id;
      credentials.hidden = !provider.value;
      credential.disabled = busy || credentials.hidden || (!choices.length && !canKeepLegacy);
      addCredential.disabled = busy || credentials.hidden;
      syncSubmit();
    }

    function showModels(previous = "") {
      const models = new Map(
        availablePresets()
          .filter((preset) => supplier(preset) === provider.value)
          .flatMap((preset) => preset.models)
          .map((entry) => [entry.id, entry.name]),
      );
      model.replaceChildren(
        option("", t(provider.value ? "creation.executorChooseModel" : "creation.executorChooseProviderFirst")),
        ...[...models].map(([value, label]) => option(value, label)),
      );
      model.value = models.has(previous) ? previous : models.size === 1 ? models.keys().next().value! : "";
      model.disabled = busy || models.size === 0;
      providerPicker.update(providerLabel.textContent ?? "", providerBrands);
      showCredentials();
    }

    function showProviders(previousProvider = "", previousModel = "") {
      const available = availablePresets();
      const choices = new Map(available.map((preset) => [supplier(preset), providerName(t, preset)]));
      providerBrands.clear();
      for (const preset of available) providerBrands.set(supplier(preset), preset.provider ?? "cli");
      const isCli = category === "cli";
      useNotice.hidden = category !== "audio" && category !== "text";
      localizeText(providerLabel, isCli ? "creation.executorCliPackage" : "creation.mediaProvider", {}, t);
      const placeholder = option("", t(isCli ? "creation.executorChooseCli" : "creation.executorChooseProvider"));
      placeholder.hidden = true;
      provider.replaceChildren(placeholder, ...[...choices].map(([value, label]) => option(value, label)));
      if (category === "image" && !existing && choices.size) {
        const midjourney = option("midjourney", t("creation.executorMidjourneyUnavailable"));
        midjourney.disabled = true;
        provider.append(midjourney);
        providerBrands.set(midjourney.value, "midjourney");
      }
      provider.value = choices.has(previousProvider)
        ? previousProvider
        : category === "image" && choices.has("openai")
          ? "openai"
          : choices.size === 1
            ? choices.keys().next().value!
            : "";
      fields.hidden = choices.size === 0;
      provider.disabled = fields.hidden === true || !!existing;
      unavailable.hidden = !category || choices.size > 0;
      if (!unavailable.hidden)
        localizeText(unavailable, isCli ? "creation.executorNoCli" : "creation.executorNoProviders", {}, t);
      showModels(previousModel);
    }

    function clearInput() {
      credential.value = "";
      status.hidden = true;
    }

    function showCategory(next: ExecutorCategory) {
      providerPicker.close();
      category = next;
      clearInput();
      if (next === "cli" && !existing) cli.show(registry);
      else {
        cli.hide();
        registry.hidden = true;
      }
      showProviders();
    }

    for (const [index, control] of controls.entries()) {
      const option = categories[index]!;
      control.checked = option === category;
      control.onchange = () => {
        if (control.checked) showCategory(option);
      };
    }
    if (existing && original) {
      displayName.value = existing.name;
      showProviders(supplier(original), existing.model ?? original.models[0]?.id);
      showCredentials(existing.credentialId ?? "legacy");
    } else showCategory(category);
    updateCatalog = (value) => {
      catalog = value;
      showProviders(provider.value, model.value);
    };
    provider.onchange = () => {
      clearInput();
      showModels();
    };
    model.onchange = () => {
      status.hidden = true;
      syncSubmit();
    };
    credential.onchange = () => {
      status.hidden = true;
      syncSubmit();
    };
    addCredential.onclick = () => {
      credentialEditor.open({
        opener: addCredential,
        presets: availablePresets().filter((preset) => supplier(preset) === provider.value),
        target: provider.value,
        saved: (saved) => {
          catalog = {
            ...catalog,
            credentials: [...(catalog.credentials ?? []).filter((item) => item.id !== saved.id), saved],
          };
          status.hidden = true;
          showCredentials(saved.id);
        },
      });
    };
    dismiss.onclick = () => dialog.close();
    form.onsubmit = (event) => {
      event.preventDefault();
      const preset = selectedPreset();
      if (!preset || !credential.value || busy) return;
      busy = true;
      dismiss.disabled = true;
      for (const control of controls) control.disabled = true;
      provider.disabled = model.disabled = submit.disabled = true;
      providerPicker.update(providerLabel.textContent ?? "", providerBrands);
      addCredential.disabled = credential.disabled = displayName.readOnly = true;
      status.hidden = false;
      status.dataset.tone = "pending";
      localizeText(status, "creation.mediaChecking", {}, t);
      void api<CreationMediaExecutor>(
        executorEndpoint,
        "POST",
        {
          preset: preset.id,
          model: model.value,
          name: displayName.value,
          ...(credential.value !== "legacy" ? { credentialId: credential.value } : {}),
          id,
          revision: existing?.revision ?? 0,
        },
        AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      )
        .then(async (saved) => {
          if (signal.aborted) return;
          await options.saved(saved);
          if (dialog.open) dialog.close();
        })
        .catch((error: { code?: string }) => {
          if (signal.aborted) return;
          const messages: Record<string, MessageId> = {
            authentication: "creation.mediaAuthentication",
            rateLimited: "creation.mediaRateLimited",
            conflict: "creation.executorConnectionChanged",
            unavailable: "creation.executorSaveRetry",
            notFound: "creation.credentialUnavailable",
          };
          status.dataset.tone = "error";
          localizeText(status, messages[error.code ?? ""] ?? "creation.mediaInvalidConnection", {}, t);
        })
        .finally(() => {
          if (signal.aborted) return;
          busy = false;
          dismiss.disabled = false;
          displayName.readOnly = false;
          for (const control of controls) control.disabled = false;
          provider.disabled = fields.hidden === true || !!existing;
          showModels(model.value);
        });
    };
    document.body.append(dialog);
    dialog.showModal();
    (existing
      ? credential.disabled
        ? addCredential
        : credential
      : controls.find((control) => control.checked)
    )?.focus();
  }

  return {
    open,
    close: () => {
      if (dialog.open) dialog.close();
    },
  };
}
