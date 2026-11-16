import type { Translate } from "../../shared/i18n/messages.js";
import type { SftpConnection } from "../../shared/connections/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

export function hostTrustForm(t: Translate, connection: SftpConnection) {
  return `<details class="delivery-trust" ${connection.trustPending ? "open" : ""}><summary>${m("connections.rotateTrust", undefined, t)}</summary>
    <form class="delivery-form" id="publicationTrustForm"><p>${m("connections.trustHint", undefined, t)}</p>
    <p data-i18n-ignore><code>${e(connection.hostKey)}</code></p>
    ${connection.trustPending ? `<p role="status">${m("connections.trustUnverified", undefined, t)}</p>` : ""}
    <label for="publish-new-host-key">${m("connections.newHostKey", undefined, t)}</label>
    <input id="publish-new-host-key" name="hostKey" required maxlength="64" placeholder="SHA256:…" autocomplete="off" spellcheck="false">
    <label class="delivery-checkbox"><input type="checkbox" required>${m("connections.trustAcknowledgement", undefined, t)}</label>
    <div class="delivery-actions"><button type="submit" class="wb-button">${m("connections.rotateTrust", undefined, t)}</button></div></form></details>`;
}
export function bindHostTrustForm(root: HTMLElement, submit: (hostKey: string) => void) {
  const form = root.querySelector<HTMLFormElement>("#publicationTrustForm");
  if (!form) return;
  form.onsubmit = (event) => {
    event.preventDefault();
    submit(String(new FormData(form).get("hostKey") || ""));
  };
}
