import { escapeHtml } from "../../shared/html.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import {
  createEncryptionKey,
  downloadKeyBackup,
  keyBackupExtension,
  keyBackupMaxBytes,
  listEncryptionKeys,
  restoreEncryptionKey,
  saveEncryptionKey,
} from "./key-store.js";

export function createEncryptionKeySettings(t: Translate) {
  let host: HTMLElement | undefined;
  let generation = 0;
  const m = (id: MessageId) => messageHtml(id, {}, t);
  function hide() {
    generation++;
    host?.replaceChildren();
    host = undefined;
  }
  function show(target: HTMLElement) {
    hide();
    host = target;
    const epoch = generation;
    setMessageHtml(
      target,
      `<section class="settings-preference-section encryption-key-settings">
      <p>${m("settings.encryptionKeysHint")}</p>
      <ul data-encryption-keys></ul>
      <p role="status"></p>
      <details><summary>${m("settings.encryptionKeyCreate")}</summary>
        <form class="wb-form" data-key-create>
          <label class="wb-field"><span>${m("settings.encryptionKeyName")}</span><input name="keyName" maxlength="80" required></label>
          <label class="wb-field"><span>${m("settings.encryptionKeyPassphrase")}</span><input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label>
          <label class="wb-field"><span>${m("settings.encryptionKeyRepeatPassphrase")}</span><input name="repeat" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label>
          <button class="wb-button primary" type="submit">${m("settings.encryptionKeyCreate")}</button>
        </form>
      </details>
      <details><summary>${m("settings.encryptionKeyRestore")}</summary>
        <form class="wb-form" data-key-restore>
          <label class="wb-field"><span>${m("settings.encryptionKeyBackup")}</span><input name="backup" type="file" accept="${keyBackupExtension}" required></label>
          <label class="wb-field"><span>${m("settings.encryptionKeyPassphrase")}</span><input name="password" type="password" autocomplete="off" maxlength="1024" required></label>
          <button class="wb-button" type="submit">${m("settings.encryptionKeyRestore")}</button>
        </form>
      </details></section>`,
    );
    const list = target.querySelector<HTMLElement>("[data-encryption-keys]")!;
    const status = target.querySelector<HTMLElement>("[role=status]")!;
    let busy = false;
    function render() {
      setMessageHtml(
        list,
        listEncryptionKeys()
          .map(
            ({ name, fingerprint }) =>
              `<li class="settings-row"><div><strong data-i18n-ignore>${escapeHtml(name)}</strong> <code data-i18n-ignore title="${fingerprint}">${fingerprint.slice(0, 16)}</code></div>
        <button type="button" class="wb-button" data-key-backup="${fingerprint}">${m("settings.encryptionKeyDownload")}</button></li>`,
          )
          .join(""),
      );
    }
    try {
      render();
    } catch {
      status.textContent = t("settings.encryptionKeyError");
      return;
    }
    list.onclick = (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-key-backup]") : null;
      const key = button && listEncryptionKeys().find((item) => item.fingerprint === button.dataset.keyBackup);
      if (key) downloadKeyBackup(key);
    };
    for (const form of target.querySelectorAll<HTMLFormElement>("form")) {
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(form);
        const password = String(data.get("password") ?? "");
        const creating = form.hasAttribute("data-key-create");
        if (creating && password !== data.get("repeat")) {
          status.textContent = t("settings.encryptionKeyPassphraseMismatch");
          return;
        }
        const button = form.querySelector<HTMLButtonElement>("button")!;
        button.disabled = busy = true;
        status.textContent = t("common.pageLoading");
        try {
          const file = data.get("backup");
          if (
            !creating &&
            (!(file instanceof File) ||
              file.size > keyBackupMaxBytes ||
              !file.name.toLowerCase().endsWith(keyBackupExtension))
          )
            throw new Error("Invalid backup file");
          const key = creating
            ? await createEncryptionKey(String(data.get("keyName") ?? ""), password)
            : await restoreEncryptionKey(JSON.parse(await (file as File).text()), password);
          if (epoch !== generation) return;
          saveEncryptionKey(key);
          render();
          form.reset();
          if (creating) downloadKeyBackup(key);
          status.textContent = t(creating ? "settings.encryptionKeyCreated" : "settings.encryptionKeyRestored");
        } catch {
          if (epoch === generation) status.textContent = t("settings.encryptionKeyError");
        } finally {
          busy = button.disabled = false;
        }
      };
    }
  }
  return { show, hide };
}
