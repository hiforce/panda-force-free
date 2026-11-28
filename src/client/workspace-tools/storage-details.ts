import { registeredStorageId, type RegisteredStorageConnection } from "../../shared/workspace-tools/storage.js";
import type { OriginalStorageCredentials, OriginalStorageSettings } from "../../shared/storage/contracts.js";
import { originalStorageErrorMessages } from "../../shared/storage/messages.js";
import { escapeHtml } from "../../shared/html.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { requireElement } from "../dom.js";
import { localizeText, messageHtml, setMessageHtml } from "../i18n.js";
import { originalStorageRequest, OriginalStorageRequestError } from "../original-storage/api.js";
import { storageConnectionsApi, StorageConnectionError } from "./storage-api.js";
import { storageProviderLabel } from "./storage-editor.js";

type ObjectConnection = Extract<RegisteredStorageConnection, { provider: "s3" | "oss" }>;

export function openStorageDetails(t: Translate, row: ObjectConnection, onSaved: () => void) {
  const dialog = document.createElement("dialog"),
    returnFocus = document.activeElement;
  const msg = (id: MessageId) => messageHtml(id, undefined, t);
  const item = (label: MessageId, value: string) =>
    `<div><dt>${msg(label)}</dt><dd data-i18n-ignore>${escapeHtml(value)}</dd></div>`;
  const field = (label: MessageId, name: string, length: number, required = false) =>
    `<label class="wb-field"><span>${msg(label)}</span><input name="storage-${name}" type="password" maxlength="${length}" autocomplete="new-password" ${required ? "required" : ""}></label>`;
  dialog.className = "workbench-dialog remote-editor storage-connection-editor";
  dialog.setAttribute("aria-labelledby", "storage-details-title");
  setMessageHtml(
    dialog,
    `<header><h2 id="storage-details-title">${msg("storageConnections.details")}</h2></header>
    <form class="wb-form">
      <div class="remote-editor-body">
        <dl class="storage-details-grid">
          ${item("storageConnections.name", row.name)}
          <div><dt>${msg("storageConnections.provider")}</dt><dd>${msg(storageProviderLabel[row.provider])}</dd></div>
          ${item("storage.bucket", row.bucket)}
          ${item("storage.region", row.region)}
          ${item("storage.endpoint", row.endpoint)}
          ${row.prefix ? item("storage.prefix", row.prefix) : ""}
        </dl>
        <details class="storage-connection-advanced" data-storage-replace>
          <summary>${msg("storageConnections.rotate")}</summary>
          <fieldset data-storage-key-fields disabled>
            ${field("storage.accessKeyId", "accessKeyId", 256, true)}
            ${field("storage.secretAccessKey", "secretAccessKey", 2048, true)}
            ${field("storage.sessionToken", "sessionToken", 16384)}
          </fieldset>
        </details>
        <p role="alert" data-storage-details-error hidden></p>
      </div>
      <footer class="remote-editor-actions">
        <div class="confirmation-actions remote-editor-submit-actions">
          <button type="button" class="wb-button" data-storage-details-close>${msg("common.close")}</button>
          <button type="submit" class="wb-button primary" hidden>${msg("storage.repairSave")}</button>
        </div>
      </footer>
    </form>`,
  );
  const form = requireElement("form", dialog) as HTMLFormElement,
    replace = requireElement("[data-storage-replace]", dialog) as HTMLDetailsElement,
    keys = requireElement("[data-storage-key-fields]", dialog) as HTMLFieldSetElement,
    submit = requireElement('button[type="submit"]', dialog) as HTMLButtonElement,
    close = requireElement("[data-storage-details-close]", dialog) as HTMLButtonElement,
    error = requireElement("[data-storage-details-error]", dialog);
  let pending = false;
  let attempt: { operationId: string; key: string; configurationRevision?: number } | null = null;
  replace.ontoggle = () => {
    keys.disabled = pending || !replace.open;
    submit.hidden = !replace.open;
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => {
    if (pending) event.preventDefault();
  });
  dialog.addEventListener(
    "close",
    () => {
      attempt = null;
      form.reset();
      dialog.remove();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    },
    { once: true },
  );

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || !replace.open || !row.credentialRevision) return;
    const data = new FormData(form),
      read = (key: string) => String(data.get("storage-" + key) ?? "").trim();
    const accessKeyId = read("accessKeyId"),
      secretAccessKey = read("secretAccessKey"),
      sessionToken = read("sessionToken");
    const credentials: OriginalStorageCredentials = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
    const key = JSON.stringify(credentials);
    if (!attempt || attempt.key !== key) attempt = { operationId: crypto.randomUUID(), key };
    const active = attempt;
    pending = keys.disabled = submit.disabled = close.disabled = true;
    error.hidden = true;
    localizeText(submit, "storage.saving", undefined, t);
    try {
      const change = { operationId: active.operationId, credentialRevision: row.credentialRevision, credentials };
      if (registeredStorageId.test(row.id)) {
        await storageConnectionsApi.rotate({ id: row.id, ...change });
      } else {
        active.configurationRevision ??= (await originalStorageRequest<OriginalStorageSettings>()).revision;
        await originalStorageRequest("", {
          revision: active.configurationRevision,
          action: "credentials",
          profileId: row.id,
          ...change,
        });
      }
      if (dialog.open) {
        dialog.close();
        onSaved();
      }
    } catch (failure) {
      if (dialog.open) {
        const named =
          failure instanceof StorageConnectionError
            ? failure.messageId
            : failure instanceof OriginalStorageRequestError
              ? originalStorageErrorMessages[failure.code]
              : "storageConnections.unavailable";
        if (failure instanceof OriginalStorageRequestError && failure.status === 409) attempt = null;
        localizeText(error, named, undefined, t);
        error.hidden = false;
      }
    } finally {
      pending = submit.disabled = close.disabled = false;
      keys.disabled = !replace.open;
      localizeText(submit, "storage.repairSave", undefined, t);
      if (dialog.open) submit.focus({ preventScroll: true });
    }
  };

  document.body.append(dialog);
  dialog.showModal();
  return () => {
    if (dialog.open) dialog.close();
  };
}
