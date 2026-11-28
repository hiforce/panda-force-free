import {
  googleStorageCallbackPath,
  storageProviders,
  type StorageProvider,
} from "../../shared/workspace-tools/storage.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { copyPlainText } from "../clipboard-text.js";
import { requireElement } from "../dom.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { StorageConnectionError, storageConnectionsApi } from "./storage-api.js";

export const storageProviderLabel = {
  s3: "storageConnections.s3Compatible",
  oss: "storageConnections.aliyunOss",
  "google-drive": "storageConnections.googleDrive",
} as const;
export const storageProviderIcon = { s3: "database", oss: "cloud", "google-drive": "folderOpen" } as const;

export function openStorageConnectionEditor(t: Translate, onSaved: () => void) {
  const dialog = document.createElement("dialog");
  const returnFocus = document.activeElement;
  const msg = (id: MessageId) => messageHtml(id, undefined, t);
  const input = (name: string, label: MessageId, options: string) =>
    `<label class="wb-field"><span>${msg(label)}</span><input name="storage-${name}" ${options}></label>`;
  dialog.className = "workbench-dialog remote-editor storage-connection-editor";
  dialog.setAttribute("aria-labelledby", "storage-connection-title");
  setMessageHtml(
    dialog,
    `<header><h2 id="storage-connection-title">${msg("storageConnections.add")}</h2></header>
    <form class="wb-form">
      <div class="remote-editor-body">
        <fieldset data-storage-editor-fields>
          <legend class="sr-only">${msg("storageConnections.add")}</legend>
          <label class="wb-field"><span>${msg("storageConnections.provider")}</span><select name="storage-provider" autofocus>
            ${storageProviders.map((provider) => `<option value="${provider}">${msg(storageProviderLabel[provider])}</option>`).join("")}
          </select></label>
          ${input("name", "storageConnections.name", 'required maxlength="120" autocomplete="off"')}
          <fieldset class="storage-provider-fields" data-storage-object>
            <legend class="sr-only">${msg("storage.connection")}</legend>
            <div class="storage-connection-fields">
              ${input("bucket", "storage.bucket", 'required maxlength="63" autocomplete="off" spellcheck="false"')}
              ${input("region", "storage.region", 'required maxlength="64" autocomplete="off" spellcheck="false"')}
            </div>
            <details class="storage-connection-advanced">
              <summary>${msg("storage.advanced")}</summary>
              ${input("endpoint", "storageConnections.endpointOptional", 'type="url" maxlength="2048" autocomplete="off"')}
              ${input("prefix", "storageConnections.prefixOptional", 'maxlength="768" autocomplete="off"')}
              <label class="wb-choice" data-storage-path-style><input type="checkbox" name="storage-forcePathStyle" value="true"><span>${msg("storage.pathStyle")}</span></label>
              ${input("sessionToken", "storage.sessionToken", 'type="password" maxlength="16384" autocomplete="new-password"')}
            </details>
            <div class="storage-connection-fields">
              ${input("accessKeyId", "storage.accessKeyId", 'required type="password" maxlength="256" autocomplete="new-password"')}
              ${input("secretAccessKey", "storage.secretAccessKey", 'required type="password" maxlength="2048" autocomplete="new-password"')}
            </div>
          </fieldset>
          <fieldset class="storage-provider-fields" data-storage-google hidden disabled>
            <legend class="sr-only">${msg("storageConnections.googleDrive")}</legend>
            <p class="wb-help">${msg("storageConnections.googleHelp")}</p>
            <label class="wb-field"><span>${msg("storageConnections.callback")}</span>
              <input readonly value="${escapeHtml(new URL(googleStorageCallbackPath, location.origin).href)}" data-storage-callback></label>
            <div class="storage-callback-actions">
              <button type="button" class="wb-button" data-storage-copy>${codexIcon("copy")}${msg("storageConnections.copyCallback")}</button>
              <span role="status" data-storage-copied></span>
            </div>
            ${input("clientId", "storageConnections.clientId", 'required maxlength="256" spellcheck="false" autocomplete="off"')}
            ${input("clientSecret", "storageConnections.clientSecret", 'required type="password" maxlength="512" autocomplete="new-password"')}
          </fieldset>
        </fieldset>
        <p data-storage-editor-error role="alert" hidden></p>
        <p data-storage-editor-status class="wb-help" role="status" hidden></p>
      </div>
      <footer class="remote-editor-actions">
        <div class="confirmation-actions remote-editor-submit-actions">
          <button type="button" class="wb-button" data-storage-cancel>${msg("common.cancel")}</button>
          <button type="submit" class="wb-button primary">${msg("common.save")}</button>
        </div>
      </footer>
    </form>`,
  );
  const form = requireElement("form", dialog) as HTMLFormElement,
    objectFields = requireElement("[data-storage-object]", form) as HTMLFieldSetElement,
    googleFields = requireElement("[data-storage-google]", form) as HTMLFieldSetElement,
    fields = requireElement("[data-storage-editor-fields]", form) as HTMLFieldSetElement,
    provider = requireElement("select", fields) as HTMLSelectElement,
    pathStyle = requireElement("[data-storage-path-style]", objectFields) as HTMLLabelElement,
    submit = requireElement('button[type="submit"]', form) as HTMLButtonElement,
    cancel = requireElement("[data-storage-cancel]", form) as HTMLButtonElement,
    notice = requireElement("[data-storage-editor-error]", form) as HTMLElement,
    status = requireElement("[data-storage-editor-status]", form) as HTMLElement;
  const id = crypto.randomUUID();
  let pending = false;
  function setProvider() {
    const kind = provider.value as StorageProvider,
      isDrive = kind === "google-drive",
      region = form.elements.namedItem("storage-region") as HTMLInputElement,
      endpoint = form.elements.namedItem("storage-endpoint") as HTMLInputElement;
    objectFields.hidden = objectFields.disabled = isDrive;
    googleFields.hidden = googleFields.disabled = !isDrive;
    pathStyle.hidden = kind === "oss";
    region.placeholder = kind === "oss" ? "cn-hangzhou" : "us-east-1";
    endpoint.placeholder = kind === "oss" ? "https://s3.oss-cn-hangzhou.aliyuncs.com" : "";
    localizeText(submit, isDrive ? "storageConnections.authorizeGoogle" : "common.save", undefined, t);
    notice.hidden = true;
  }
  provider.onchange = setProvider;
  const callback = requireElement("[data-storage-callback]", googleFields) as HTMLInputElement;
  callback.onfocus = () => callback.select();
  const copy = requireElement("[data-storage-copy]", googleFields) as HTMLButtonElement;
  const copied = requireElement("[data-storage-copied]", googleFields);
  copy.onclick = async () => {
    try {
      await copyPlainText(callback.value);
      localizeText(copied, "common.copied", undefined, t);
    } catch {
      callback.focus();
      localizeText(copied, "storageConnections.copyManually", undefined, t);
    }
  };
  cancel.onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });
  dialog.addEventListener(
    "close",
    () => {
      form.reset();
      dialog.remove();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    },
    { once: true },
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const values = Object.fromEntries(
      [...new FormData(form)].map(([key, value]) => [key.slice("storage-".length), value]),
    );
    const isDrive = values.provider === "google-drive";
    pending = fields.disabled = submit.disabled = cancel.disabled = true;
    notice.hidden = true;
    status.hidden = false;
    localizeText(status, isDrive ? "storageConnections.preparingConsent" : "storage.saving", undefined, t);
    let leaving = false;
    try {
      const result = await storageConnectionsApi.add({
        ...values,
        id,
        forcePathStyle: values.forcePathStyle === "true",
      });
      if (!dialog.open) return;
      if (isDrive) {
        const redirect = new URL(result.authorizationUrl || "");
        if (redirect.origin !== "https://accounts.google.com" || redirect.pathname !== "/o/oauth2/v2/auth")
          throw new Error("Invalid Google consent address");
        location.assign(redirect.href);
        leaving = true;
        return;
      }
      if (!result.connection) throw new Error("Missing storage connection");
      dialog.close();
      onSaved();
    } catch (error) {
      if (dialog.open) {
        notice.hidden = false;
        localizeText(
          notice,
          error instanceof StorageConnectionError ? error.messageId : "storageConnections.unavailable",
          undefined,
          t,
        );
      }
    } finally {
      if (!leaving) {
        pending = fields.disabled = submit.disabled = cancel.disabled = false;
        status.hidden = true;
        if (dialog.open) submit.focus({ preventScroll: true });
      }
    }
  };
  setProvider();
  document.body.append(dialog);
  dialog.showModal();
  return () => {
    if (dialog.open) dialog.close();
  };
}
