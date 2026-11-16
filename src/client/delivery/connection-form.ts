import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { ConnectionInput, PublicationConnection, PublicationRoot } from "../../shared/connections/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";
import { credentialForm } from "./credential-form.js";
import { hostTrustForm } from "./host-trust-form.js";

function field(t: Translate, key: string, label: MessageId, value: string, extra = "") {
  return `<label class="wb-field" for="publish-${key}"><span>${m(label, undefined, t)}</span><input id="publish-${key}" name="publication-${key}" value="${e(value)}" ${extra}></label>`;
}
export function connectionForm(
  t: Translate,
  roots: PublicationRoot[],
  connection: PublicationConnection | null,
  kind: ConnectionInput["connector"],
  draft: { name: string; url: string },
) {
  const type = connection?.connector || kind,
    immutable = connection ? "disabled data-connection-immutable" : "";
  const local = connection?.connector === "local-site" ? connection : null,
    remote = connection?.connector === "sftp-site" ? connection : null;
  return `<form class="delivery-form wb-form" id="publicationConnectionForm">
    <label class="wb-field" for="publish-connector"><span>${m("connections.connector", undefined, t)}</span><select id="publish-connector" name="publication-connector" ${immutable}><option value="local-site" ${type === "local-site" ? "selected" : ""}>${m("connections.localSite", undefined, t)}</option><option value="sftp-site" ${type === "sftp-site" ? "selected" : ""}>${m("connections.sftpSite", undefined, t)}</option></select></label>
    ${field(t, "name", "connections.name", connection?.name || draft.name, 'required maxlength="120"')}
    ${
      type === "local-site"
        ? `<label class="wb-field" for="publish-root"><span>${m("connections.root", undefined, t)}</span><select id="publish-root" name="publication-root" ${immutable}>${roots.map((root) => `<option value="${e(root.id)}" ${local?.root === root.id ? "selected" : ""}>${e(root.id)} · ${e(root.path)}</option>`).join("")}</select></label>`
        : field(
            t,
            "host",
            "connections.host",
            remote?.host || "",
            `required maxlength="253" autocapitalize="off" ${immutable}`,
          ) +
          field(
            t,
            "port",
            "connections.port",
            String(remote?.port || 22),
            `type="number" min="1" max="65535" required ${immutable}`,
          ) +
          field(
            t,
            "username",
            "connections.username",
            remote?.username || "",
            `required maxlength="64" autocomplete="off" ${immutable}`,
          ) +
          field(
            t,
            "hostKey",
            "connections.hostKey",
            remote?.hostKey || "",
            `required maxlength="64" placeholder="SHA256:…" ${immutable}`,
          )
    }
    ${field(t, "directory", "connections.directory", connection?.directory || "", `required maxlength="500" ${immutable}`)}
    ${field(t, "url", "connections.publicUrl", connection?.publicUrl || draft.url, 'type="url" required maxlength="660"')}
    ${connection ? `<label class="delivery-checkbox"><input type="checkbox" name="publication-enabled" ${connection.enabled ? "checked" : ""}>${m("connections.enabled", undefined, t)}</label><p>${m("connections.immutable", undefined, t)}</p>` : ""}
    ${type === "sftp-site" ? `<p>${m("connections.sftpHint", undefined, t)}</p>` : ""}
    <div class="delivery-actions"><button type="submit" class="wb-button primary">${m("connections.save", undefined, t)}</button>${connection ? `<button type="button" class="wb-button" data-connection-test ${remote && !remote.credentialRevision ? "disabled" : ""}>${m("connections.test", undefined, t)}</button><button type="button" class="wb-button" data-connection-refresh>${m("connections.refreshConnection", undefined, t)}</button>` : ""}</div></form>
    ${remote ? credentialForm(t, remote) + hostTrustForm(t, remote) : ""}`;
}
