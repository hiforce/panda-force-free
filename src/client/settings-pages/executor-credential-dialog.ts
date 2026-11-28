import { executorCredentialTarget } from "../../shared/creation/media-executors.js";
import type { CreationMediaCredential, CreationMediaPreset } from "../../shared/creation/media-executors.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { harnessApi } from "../harness/api.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { credentialEndpoint, providerName } from "./executor-catalog.js";
import type { ExecutorBrand } from "./executor-brands.js";
import { createExecutorPicker } from "./executor-picker.js";

interface CredentialDialogOptions {
  opener: HTMLElement;
  presets: readonly CreationMediaPreset[];
  target?: string;
  existing?: CreationMediaCredential;
  saved(credential: CreationMediaCredential): Promise<void> | void;
  focusFallback?(): HTMLElement | undefined;
}

export function createExecutorCredentialDialog(t: Translate) {
  const api = harnessApi(t);
  const dialog = document.createElement("dialog");
  dialog.className = "session-dialog executor-dialog";
  dialog.setAttribute("aria-labelledby", "executor-credential-title");
  let dismiss: (() => void) | undefined;
  let busy = false;
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    dismiss?.();
    dismiss = undefined;
    dialog.remove();
    dialog.replaceChildren();
    busy = false;
  });

  function open({ opener, presets, target, existing, saved, focusFallback }: CredentialDialogOptions) {
    if (dialog.open) return;
    const selected = existing?.target ?? target;
    const choices = new Map(presets.map((preset) => [executorCredentialTarget(preset), preset]));
    if (!choices.size || (selected && !choices.has(selected))) return;
    const controller = new AbortController();
    const { signal } = controller;
    const id = existing?.id ?? crypto.randomUUID();
    const m = (key: MessageId) => messageHtml(key, {}, t);
    setMessageHtml(
      dialog,
      `
      <header class="session-dialog-heading executor-dialog-heading">
        <div><h2 id="executor-credential-title">${m(existing ? "creation.credentialEdit" : "creation.credentialAdd")}</h2></div>
      </header>
      <form class="session-dialog-form wb-form">
        <div class="session-dialog-body executor-dialog-body">
          <div class="wb-field"><span>${m("creation.mediaProvider")}</span><select name="credentialTarget" required></select></div>
          <label class="wb-field"><span>${m("creation.credentialName")}</span><input name="credentialName" maxlength="80" required></label>
          <label class="wb-field"><span>${m("creation.mediaApiKey")}</span><input name="credentialKey" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false"></label>
          <p class="executor-form-notice" data-credential-keep${existing ? "" : " hidden"}>${m("creation.credentialKeepKey")}</p>
          <details class="executor-advanced">
            <summary>${m("creation.executorAdvanced")}</summary>
            <label class="wb-field"><span>${m("creation.mediaBaseUrl")}</span><input name="credentialBaseUrl" type="url" maxlength="2048"></label>
          </details>
          <p class="executor-form-notice" role="status" hidden></p>
        </div>
        <footer class="session-dialog-actions">
          <button type="button" class="session-button" data-credential-cancel>${m("common.cancel")}</button>
          <button type="submit" class="session-button primary">${m("common.save")}</button>
        </footer>
      </form>`,
    );
    const form = dialog.querySelector("form")!;
    const provider = form.querySelector<HTMLSelectElement>('[name="credentialTarget"]')!;
    const name = form.querySelector<HTMLInputElement>('[name="credentialName"]')!;
    const key = form.querySelector<HTMLInputElement>('[name="credentialKey"]')!;
    const url = form.querySelector<HTMLInputElement>('[name="credentialBaseUrl"]')!;
    const advanced = form.querySelector<HTMLDetailsElement>("details.executor-advanced")!;
    const status = form.querySelector<HTMLElement>("[role=status]")!;
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const cancel = form.querySelector<HTMLButtonElement>("[data-credential-cancel]")!;
    const picker = createExecutorPicker(provider);
    const brands = new Map<string, ExecutorBrand>();
    const placeholder = new Option(t("creation.executorChooseProvider"), "");
    placeholder.hidden = true;
    provider.add(placeholder);
    for (const [value, preset] of choices) {
      provider.add(new Option(providerName(t, preset), value));
      brands.set(value, preset.provider ?? "cli");
    }
    provider.value = selected ?? "";
    name.value = existing?.name ?? "";
    url.value = existing?.baseUrl ?? "";
    advanced.open = !!url.value;
    function render() {
      provider.disabled = busy || !!selected;
      const preset = choices.get(provider.value);
      advanced.hidden = !preset || !!preset.fixedEndpoint;
      url.disabled = advanced.hidden;
      key.required = !existing || url.value.trim() !== (existing.baseUrl ?? "");
      submit.disabled = busy || !preset;
      cancel.disabled = busy;
      name.readOnly = key.readOnly = url.readOnly = busy;
      picker.update(t("creation.mediaProvider"), brands);
    }
    provider.onchange = () => {
      key.value = "";
      url.value = "";
      status.hidden = true;
      render();
    };
    url.oninput = render;
    render();
    dismiss = () => {
      controller.abort();
      picker.close();
      key.value = "";
      (opener.isConnected ? opener : focusFallback?.())?.focus();
    };
    cancel.onclick = () => dialog.close();
    form.onsubmit = (event) => {
      event.preventDefault();
      if (busy || !choices.has(provider.value)) return;
      busy = true;
      render();
      status.hidden = false;
      status.dataset.tone = "pending";
      localizeText(status, "creation.credentialSaving", {}, t);
      void api<CreationMediaCredential>(
        credentialEndpoint,
        "POST",
        {
          id,
          target: provider.value,
          name: name.value,
          revision: existing?.revision ?? 0,
          ...(key.value ? { apiKey: key.value } : {}),
          ...(!url.disabled && url.value.trim() ? { baseUrl: url.value.trim() } : {}),
        },
        AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      )
        .then(async (value) => {
          if (signal.aborted) return;
          key.value = "";
          await saved(value);
          if (!signal.aborted) dialog.close();
        })
        .catch((error: { code?: string }) => {
          if (signal.aborted) return;
          status.dataset.tone = "error";
          localizeText(
            status,
            error.code === "conflict"
              ? "creation.credentialConflict"
              : error.code === "invalidInput"
                ? "creation.credentialInvalid"
                : "creation.credentialTryAgain",
            {},
            t,
          );
        })
        .finally(() => {
          if (signal.aborted) return;
          busy = false;
          render();
        });
    };
    document.body.append(dialog);
    dialog.showModal();
    if (selected) name.focus();
  }
  return {
    open,
    close: () => {
      if (dialog.open) dialog.close();
    },
  };
}
