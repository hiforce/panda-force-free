import { setMessageHtml, setOpaqueText } from "./i18n.js";

import { createLatestRequestGate } from "./ui-core.js";
import { codexIcon } from "./codex-icons.js";

/**
 * Account identity surfaces: /api/account loading with a latest-request gate,
 * the avatar/plan rendering across footer, menu and settings, and the
 * account menu toggle.
 */
export function createAccountView({
  $,
  t,
  state,
  setSettingsPage,
  filterSettingsNavigation,
  syncPermissionSettings,
  syncPermissionControl,
}) {
  const accountRequestGate = createLatestRequestGate();
  async function loadAccount(refresh = false) {
    const requestId = accountRequestGate.next();
    try {
      const response = await fetch(`/api/account${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }),
        account = await response.json();
      if (!response.ok) throw new Error(account.error || "Cannot load account");
      if (!accountRequestGate.isCurrent(requestId)) return;
      state.account = account;
      renderAccount(account);
    } catch {
      if (accountRequestGate.isCurrent(requestId))
        renderAccount({ displayName: null, avatarUrl: null, planType: null, initials: "?" });
    }
  }
  function renderAccount(account) {
    state.account = account;
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
    const profileMenuAvailable = type === "chatgpt";
    setOpaqueText($("#accountName"), displayName);
    setOpaqueText($("#accountMenuName"), displayName);
    setOpaqueText($("#settingsAccountName"), displayName);
    setOpaqueText($("#accountFooterMeta"), "");
    setOpaqueText($("#accountMenuSubtitle"), plan);
    setOpaqueText($("#settingsAccountMeta"), plan || t("common.codexModelAccount"));
    $("#accountButton").setAttribute("aria-label", profileMenuAvailable ? "Open profile menu" : "Open settings");
    const avatarUrl =
        profileMenuAvailable &&
        typeof account?.avatarUrl === "string" &&
        account.avatarUrl.startsWith("/api/account/avatar")
          ? account.avatarUrl
          : "",
      profileAvatars = [$("#accountMenuAvatar"), $("#settingsAccountAvatar")],
      footerAvatar = $("#accountAvatar"),
      profileAvatarClass = (avatar) =>
        `account-avatar${avatar.id === "accountMenuAvatar" ? " account-menu-avatar" : ""}`;
    for (const avatar of profileAvatars) {
      avatar.dataset.imageUrl = avatarUrl;
      avatar.className = `${profileAvatarClass(avatar)} account-initials`;
      setOpaqueText(avatar, initials);
    }
    if (profileMenuAvailable) {
      footerAvatar.dataset.imageUrl = avatarUrl;
      footerAvatar.className = "account-avatar account-initials";
      setOpaqueText(footerAvatar, initials);
      profileAvatars.unshift(footerAvatar);
    } else {
      footerAvatar.dataset.imageUrl = "";
      footerAvatar.className = "account-avatar account-settings-icon";
      setMessageHtml(footerAvatar, codexIcon("wrench"));
    }
    if (avatarUrl) {
      const image = new Image();
      image.alt = "";
      image.src = `${avatarUrl}?v=${Date.now()}`;
      image.onload = () => {
        for (const avatar of profileAvatars) {
          if (avatar.dataset.imageUrl !== avatarUrl) continue;
          avatar.className = profileAvatarClass(avatar);
          avatar.replaceChildren(image.cloneNode());
        }
      };
      image.onerror = () => {
        for (const avatar of profileAvatars) {
          if (avatar.dataset.imageUrl !== avatarUrl) continue;
          avatar.className = `${profileAvatarClass(avatar)} account-initials`;
          setOpaqueText(avatar, initials);
        }
      };
    }
    if (!profileMenuAvailable) toggleAccountMenu(false);
    const apiMode = !profileMenuAvailable;
    $("#accountProfile").hidden = apiMode;
    $("#accountUsage").hidden = apiMode;
    $("#accountLogout").hidden = apiMode;
    const accountSettingsPage = $('[data-settings-page="profile"]');
    if (accountSettingsPage) {
      accountSettingsPage.dataset.settingsAvailable = "true";
      filterSettingsNavigation($("#settingsSearch")?.value || "");
    }
    syncPermissionSettings();
    syncPermissionControl();
  }
  function toggleAccountMenu(force) {
    const menu = $("#accountMenu"),
      open = force ?? menu.hidden;
    menu.hidden = !open;
    $("#accountButton").setAttribute("aria-expanded", String(open));
  }

  return { loadAccount, renderAccount, toggleAccountMenu };
}
