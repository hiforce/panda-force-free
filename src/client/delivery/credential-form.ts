import type { Translate } from "../../shared/i18n/messages.js";
import type { PublicationConnection } from "../../shared/connections/contracts.js";
import { messageHtml as m } from "../i18n.js";

export function credentialForm(t: Translate, connection: PublicationConnection) {
  return `<form class="delivery-form delivery-credentials" id="publicationCredentialForm"><h4>${m("connections.credentials", undefined, t)}</h4>
    <p>${connection.credentialRevision ? m("connections.credentialConfigured", { version: connection.credentialRevision }, t) : m("connections.credentialNeeded", undefined, t)}</p>
    <label for="secret-method">${m("connections.authMethod", undefined, t)}</label><select id="secret-method" name="publication-secret-method"><option value="privateKey">${m("connections.privateKey", undefined, t)}</option><option value="password">${m("connections.password", undefined, t)}</option></select>
    <div data-secret-kind="privateKey"><label for="secret-key">${m("connections.privateKey", undefined, t)}</label><textarea id="secret-key" name="publication-secret-key" required maxlength="32768" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
    <label for="secret-passphrase">${m("connections.passphrase", undefined, t)}</label><input id="secret-passphrase" name="publication-secret-passphrase" type="password" maxlength="4096" autocomplete="new-password"></div>
    <div data-secret-kind="password" hidden><label for="secret-password">${m("connections.password", undefined, t)}</label><input id="secret-password" name="publication-secret-password" type="password" required maxlength="4096" autocomplete="new-password" disabled></div>
    <p>${m("connections.credentialPrivacy", undefined, t)}</p><div class="delivery-actions"><button type="submit" class="wb-button">${m("connections.saveCredential", undefined, t)}</button></div></form>`;
}

/** Bind secret inputs independently of connection metadata and polling state. */
export function bindCredentialForm(root: HTMLElement, submit: (credential: Record<string, string>) => void) {
  const form = root.querySelector<HTMLFormElement>("#publicationCredentialForm");
  if (!form) return;
  const method = form.querySelector<HTMLSelectElement>("#secret-method")!;
  method.onchange = () => {
    for (const section of form.querySelectorAll<HTMLElement>("[data-secret-kind]")) {
      section.hidden = section.dataset.secretKind !== method.value;
      for (const input of section.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"))
        input.disabled = section.hidden;
    }
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const values = new FormData(form),
      value = (key: string) => String(values.get("publication-secret-" + key) || "");
    submit(
      method.value === "password"
        ? { method: "password", password: value("password") }
        : { method: "privateKey", privateKey: value("key"), passphrase: value("passphrase") },
    );
  };
}
