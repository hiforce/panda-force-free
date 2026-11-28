import { escapeHtml } from "../../shared/html.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { localizeText, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import {
  createEncryptionKey,
  downloadKeyBackup,
  keyBackupExtension,
  keyBackupMaxBytes,
  listEncryptionKeys,
  restoreEncryptionKey,
  saveEncryptionKey,
  type KeyBackup,
} from "./key-store.js";

export function createEncryptionKeySettings(t: Translate) {
  let host: HTMLElement | undefined;
  let editor: HTMLDialogElement | undefined;
  const m = (id: MessageId) => messageHtml(id, {}, t);

  function hide() {
    const dialog = editor;
    editor = undefined;
    dialog?.close();
    dialog?.remove();
    host?.replaceChildren();
    host = undefined;
  }

  function show(target: HTMLElement) {
    hide();
    host = target;
    setMessageHtml(
      target,
      `<div class="encryption-key-settings">
        <p class="encryption-key-purpose">${m("settings.encryptionKeyPurpose")}</p>
        <section class="encryption-key-panel" aria-labelledby="encryption-key-list-title">
          <header class="encryption-key-panel-header">
            <h2 id="encryption-key-list-title">${m("settings.encryptionKeyList")}</h2>
            <div class="encryption-key-actions">
              <button type="button" class="wb-button" data-open-key-restore>${codexIcon("folderOpen")}${m("settings.encryptionKeyRestore")}</button>
              <button type="button" class="wb-button primary" data-open-key-create>${codexIcon("plus")}${m("settings.encryptionKeyCreate")}</button>
            </div>
          </header>
          <p class="encryption-key-feedback" data-key-status role="status" hidden></p>
          <ul class="encryption-key-list" data-encryption-keys hidden></ul>
          <div class="encryption-key-empty" data-key-empty hidden>
            ${codexIcon("lockKeyhole", "encryption-key-mark")}
            <h3>${m("settings.encryptionKeyEmpty")}</h3>
          </div>
          <div class="encryption-key-load-error" data-key-load-error hidden>
            <p>${m("settings.encryptionKeyStorageError")}</p>
            <button type="button" class="wb-button" data-key-retry>${m("common.retry")}</button>
          </div>
        </section>
        <aside class="encryption-key-backup-note" aria-labelledby="encryption-key-backup-title">
          ${codexIcon("shield")}
          <div>
            <h2 id="encryption-key-backup-title">${m("settings.encryptionKeyBackupTitle")}</h2>
            <p>${m("settings.encryptionKeysHint")}</p>
          </div>
        </aside>
      </div>`,
    );

    const list = target.querySelector<HTMLUListElement>("[data-encryption-keys]")!;
    const empty = target.querySelector<HTMLElement>("[data-key-empty]")!;
    const loadError = target.querySelector<HTMLElement>("[data-key-load-error]")!;
    const status = target.querySelector<HTMLElement>("[data-key-status]")!;
    const create = target.querySelector<HTMLButtonElement>("[data-open-key-create]")!;
    const restore = target.querySelector<HTMLButtonElement>("[data-open-key-restore]")!;
    let keys: KeyBackup[] = [];

    function render() {
      try {
        keys = listEncryptionKeys();
      } catch {
        keys = [];
        list.replaceChildren();
        list.hidden = empty.hidden = create.disabled = restore.disabled = true;
        loadError.hidden = false;
        return;
      }
      empty.hidden = keys.length > 0;
      list.hidden = !keys.length;
      create.disabled = restore.disabled = false;
      loadError.hidden = true;
      setMessageHtml(
        list,
        keys
          .map(
            ({ name, fingerprint }) => `<li class="encryption-key-row">
              ${codexIcon("lockKeyhole", "encryption-key-mark")}
              <div class="encryption-key-row-details">
                <h3 data-i18n-ignore>${escapeHtml(name)}</h3>
                <p>${m("settings.encryptionKeyFingerprint")} <code data-i18n-ignore title="${fingerprint}">${fingerprint.slice(0, 16)}…</code></p>
              </div>
              <button type="button" class="wb-button" data-key-backup="${fingerprint}">${codexIcon("download")}${m("settings.encryptionKeyDownload")}</button>
            </li>`,
          )
          .join(""),
      );
    }

    list.onclick = (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-key-backup]") : null;
      const key = button && keys.find((entry) => entry.fingerprint === button.dataset.keyBackup);
      if (key) downloadKeyBackup(key);
    };
    target.querySelector<HTMLButtonElement>("[data-key-retry]")!.onclick = render;
    create.onclick = () => open(create, true);
    restore.onclick = () => open(restore, false);

    function open(opener: HTMLButtonElement, creating: boolean) {
      if (editor || host !== target) return;
      const dialog = document.createElement("dialog");
      dialog.className = "session-dialog encryption-key-dialog";
      dialog.setAttribute("aria-labelledby", "encryption-key-dialog-title");
      const action = creating ? "settings.encryptionKeyCreate" : "settings.encryptionKeyRestore";
      setMessageHtml(
        dialog,
        `<header class="session-dialog-heading">
          <div>
            <h2 id="encryption-key-dialog-title">${m(action)}</h2>
            <p>${m(creating ? "settings.encryptionKeyCreateHint" : "settings.encryptionKeyRestoreHint")}</p>
          </div>
        </header>
        <form class="session-dialog-form wb-form" ${creating ? "data-key-create" : "data-key-restore"}>
          <div class="session-dialog-body encryption-key-form">
            ${
              creating
                ? `<label class="wb-field"><span>${m("settings.encryptionKeyName")}</span><input name="keyName" maxlength="80" required></label>`
                : `
              <div class="wb-field">
                <span>${m("settings.encryptionKeyBackup")}</span>
                <input type="file" name="backup" accept="${keyBackupExtension}" hidden>
                <button type="button" class="wb-button encryption-key-choose" data-key-choose>${codexIcon("folderOpen")}${m("settings.encryptionKeyChooseBackup")}</button>
                <span class="encryption-key-file-name" data-key-file role="status" hidden></span>
              </div>`
            }
            <label class="wb-field"><span>${m("settings.encryptionKeyPassphrase")}</span><input name="password" type="password" autocomplete="${creating ? "new-password" : "off"}"${creating ? ' minlength="12"' : ""} maxlength="1024" required></label>
            ${creating ? `<label class="wb-field"><span>${m("settings.encryptionKeyRepeatPassphrase")}</span><input name="repeat" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label>` : ""}
            <p class="encryption-key-feedback" data-key-dialog-status role="status" hidden></p>
          </div>
          <footer class="session-dialog-actions">
            <button type="button" class="session-button" data-key-cancel>${m("common.cancel")}</button>
            <button type="submit" class="session-button primary">${m(action)}</button>
          </footer>
        </form>`,
      );
      const form = dialog.querySelector("form")!;
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      const cancel = form.querySelector<HTMLButtonElement>("[data-key-cancel]")!;
      const notice = form.querySelector<HTMLElement>("[data-key-dialog-status]")!;
      const backup = form.querySelector<HTMLInputElement>('[name="backup"]');
      const choose = form.querySelector<HTMLButtonElement>("[data-key-choose]");
      const fileName = form.querySelector<HTMLElement>("[data-key-file]");
      let busy = false;
      const current = () => editor === dialog && dialog.open && host === target;
      function feedback(message: MessageId, tone: "pending" | "error") {
        notice.hidden = false;
        notice.dataset.tone = tone;
        localizeText(notice, message, {}, t);
      }
      if (backup && choose && fileName) {
        choose.onclick = () => backup.click();
        backup.onchange = () => {
          const file = backup.files?.[0];
          fileName.hidden = !file;
          setOpaqueText(fileName, file?.name ?? "");
          notice.hidden = true;
        };
      }
      cancel.onclick = () => dialog.close();
      dialog.addEventListener("cancel", (event) => {
        if (busy) event.preventDefault();
      });
      dialog.addEventListener("close", () => {
        form.reset();
        dialog.remove();
        if (editor === dialog) {
          editor = undefined;
          if (opener.isConnected) opener.focus({ preventScroll: true });
        }
      });
      form.oninput = () => {
        if (!busy) notice.hidden = true;
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (!current() || busy) return;
        const data = new FormData(form);
        const password = String(data.get("password") ?? "");
        const file = backup?.files?.[0];
        if (creating && password !== data.get("repeat")) {
          feedback("settings.encryptionKeyPassphraseMismatch", "error");
          form.querySelector<HTMLInputElement>('[name="repeat"]')?.focus();
          return;
        }
        if (
          !creating &&
          (!file || file.size > keyBackupMaxBytes || !file.name.toLowerCase().endsWith(keyBackupExtension))
        ) {
          feedback("settings.encryptionKeyBackupInvalid", "error");
          choose?.focus();
          return;
        }
        busy = submit.disabled = cancel.disabled = true;
        if (choose) choose.disabled = true;
        for (const input of form.querySelectorAll<HTMLInputElement>('input:not([type="file"])')) input.readOnly = true;
        feedback(creating ? "settings.encryptionKeyGenerating" : "settings.encryptionKeyRestoring", "pending");
        try {
          const key = creating
            ? await createEncryptionKey(String(data.get("keyName") ?? ""), password)
            : await restoreEncryptionKey(JSON.parse(await file!.text()), password);
          if (!current()) return;
          saveEncryptionKey(key);
          render();
          dialog.close();
          status.dataset.tone = "success";
          status.hidden = false;
          localizeText(status, creating ? "settings.encryptionKeyCreated" : "settings.encryptionKeyRestored", {}, t);
          if (creating) downloadKeyBackup(key);
        } catch {
          if (current())
            feedback(creating ? "settings.encryptionKeyGenerateError" : "settings.encryptionKeyError", "error");
        } finally {
          if (current()) {
            busy = submit.disabled = cancel.disabled = false;
            if (choose) choose.disabled = false;
            for (const input of form.querySelectorAll<HTMLInputElement>('input:not([type="file"])'))
              input.readOnly = false;
          }
        }
      };
      editor = dialog;
      document.body.append(dialog);
      dialog.showModal();
    }

    render();
  }
  return { show, hide };
}
