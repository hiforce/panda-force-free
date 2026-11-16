import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SocialAccount } from "../../shared/connections/accounts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

const button = (t: Translate, id: MessageId, action: string) =>
  `<button type="button" class="wb-button" data-account-action="${action}">${m(id, undefined, t)}</button>`;
export function accountFrame(t: Translate) {
  return `<h3>${m("accounts.title", undefined, t)}</h3><p>${m("accounts.hint", undefined, t)}</p><div class="wb-form"><label class="wb-field" for="socialAccountPicker"><span>${m("accounts.choose", undefined, t)}</span><select id="socialAccountPicker"></select></label></div><p id="socialAccountNotice" role="status" hidden></p><div id="socialAccountForm"></div>`;
}
export function accountForm(t: Translate, account: SocialAccount | null, callback: string, replace: boolean) {
  const field = (id: string, key: MessageId, value: string, extra = "") =>
    `<label class="wb-field" for="account-${id}"><span>${m(key, undefined, t)}</span><input id="account-${id}" name="${id}" value="${e(value)}" ${extra}></label>`;
  const configure = !account || replace;
  const status: MessageId =
    !account?.enabled && account
      ? "accounts.disabled"
      : !account?.grant
        ? "accounts.notAuthorized"
        : account.authorizationState === "reauthorizationRequired"
          ? "accounts.reauthorize"
          : account.authorizationState === "refreshing"
            ? "accounts.refreshing"
            : account.grant.expiresAt <= Date.now()
              ? "accounts.expired"
              : "accounts.authorized";
  return `<form id="socialAccountEditor" class="delivery-form wb-form">${field("name", "connections.name", account?.name || "", 'required maxlength="120"')}
    ${configure ? `${field("clientId", "accounts.clientId", account?.application.clientId || "", 'required maxlength="1024" autocomplete="off" autocapitalize="off" spellcheck="false"')}${field("clientSecret", "accounts.clientSecret", "", 'type="password" maxlength="2048" autocomplete="new-password"')}<p>${m(replace ? "accounts.replaceHint" : "accounts.secretHint", undefined, t)}</p>${field("callback", "accounts.callback", callback, "readonly")}<p>${m("accounts.callbackHint", undefined, t)}</p>` : `<dl class="wb-description-list"><dt>${m("accounts.clientId", undefined, t)}</dt><dd data-i18n-ignore>${e(account.application.clientId)}</dd><dt>${m("accounts.callback", undefined, t)}</dt><dd data-i18n-ignore>${e(account.application.callbackUrl)}</dd></dl>`}
    ${account ? `<label class="delivery-checkbox"><input name="enabled" type="checkbox" ${account.enabled ? "checked" : ""}>${m("connections.enabled", undefined, t)}</label>` : ""}
    <div class="delivery-actions"><button type="submit" class="wb-button primary">${m("accounts.save", undefined, t)}</button>${button(t, "accounts.refresh", "refresh")}</div></form>
    ${account ? `<section class="account-grant"><h4>${m(status, undefined, t)}</h4>${account.authorizationState === "reauthorizationRequired" || account.authorizationState === "refreshing" ? `<p role="status">${m(account.authorizationState === "refreshing" ? "accounts.refreshHint" : "accounts.reauthorizeHint", undefined, t)}</p>` : ""}${account.account ? `<dl class="wb-description-list"><dt>${m("accounts.verifiedAccount", undefined, t)}</dt><dd data-i18n-ignore>@${e(account.account.username)} · ${e(account.account.name)}</dd></dl><p>${m("accounts.identityHint", undefined, t)}</p>` : ""}<p>${m("accounts.capabilityHint", undefined, t)}</p><div class="delivery-actions">${account.enabled ? button(t, "accounts.authorize", "authorize") : ""}${button(t, "accounts.replaceApplication", "configure")}${account.grant ? button(t, "accounts.disconnect", "disconnect") : ""}</div>${account.grant ? `<p>${m("accounts.disconnectHint", undefined, t)}</p>` : ""}</section>` : ""}`;
}
