import { request as fetch } from "./http-client.js";
import { localizeText, setOpaqueText } from "./i18n.js";
import { createLatestRequestGate } from "./ui-core.js";
/**
 * Account identity surfaces: /api/account loading with a latest-request gate,
 * and the model account identity and available actions in settings.
 */
export function createAccountView({
  $,
  t,
  filterSettingsNavigation,
  syncPermissionSettings,
  syncPermissionControl,
  mutations,
}) {
  const accountRequestGate = createLatestRequestGate();
  async function loadAccount(refresh = false) {
    const requestId = accountRequestGate.next();
    try {
      const response = await fetch(`/api/account${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }),
        account = await response.json();
      if (!response.ok) throw new Error(account.error || "Cannot load account");
      if (!accountRequestGate.isCurrent(requestId)) return;
      mutations.set("account", account);
      renderAccount(account);
    } catch {
      if (accountRequestGate.isCurrent(requestId))
        renderAccount({ displayName: null, avatarUrl: null, planType: null, initials: "?" });
    }
  }
  function renderAccount(account) {
    mutations.set("account", account);
    const displayName = account?.displayName?.trim() || t("common.settings"),
      initials = account?.initials?.trim() || "?",
      type = account?.type || "unknown",
      plan = account?.planType
        ? `${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)} plan`
        : type === "apiKey"
          ? t("workbench.apiKeyMode")
          : type === "amazonBedrock"
            ? "Amazon Bedrock"
            : "";
    if (type !== "unknown" && account?.displayName?.trim()) setOpaqueText($("#settingsAccountName"), displayName);
    else localizeText($("#settingsAccountName"), "common.settings", undefined, t);
    setOpaqueText($("#settingsAccountMeta"), plan || t("common.codexModelAccount"));
    const avatar = $("#settingsAccountAvatar");
    const avatarUrl =
      type === "chatgpt" &&
      typeof account?.avatarUrl === "string" &&
      account.avatarUrl.startsWith("/api/account/avatar")
        ? account.avatarUrl
        : "";
    avatar.dataset.imageUrl = avatarUrl;
    avatar.className = "account-avatar account-initials";
    setOpaqueText(avatar, initials);
    if (avatarUrl) {
      const image = new Image();
      image.alt = "";
      image.src = `${avatarUrl}?v=${Date.now()}`;
      image.onload = () => {
        if (avatar.dataset.imageUrl !== avatarUrl) return;
        avatar.className = "account-avatar";
        avatar.replaceChildren(image);
      };
    }
    $("#settingsModelAccountActions").hidden = type !== "chatgpt";
    const accountSettingsPage = $('[data-settings-page="profile"]');
    if (accountSettingsPage) {
      accountSettingsPage.dataset.settingsAvailable = "true";
      filterSettingsNavigation($("#settingsSearch")?.value || "");
    }
    syncPermissionSettings();
    syncPermissionControl();
  }
  return { loadAccount, renderAccount };
}
