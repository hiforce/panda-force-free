import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

import { launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const base = runtime.base;
const browser = await runtime.launchBrowser(launchOptions());
const context = await browser.newContext({ viewport: { width: 1120, height: 760 }, colorScheme: "dark" });
await context.addInitScript(() => {
  if (window === window.top) localStorage.setItem("panda-force-locale", "en");
});
const page = await context.newPage();
page.setDefaultTimeout(7000);
const originalWait = page.waitForFunction.bind(page);
page.waitForFunction = async (...args) => {
  try {
    return await originalWait(...args);
  } catch (error) {
    console.error("Wait failed:", String(args[0]));
    throw error;
  }
};
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => globalThis.__pandaForceDebug?.renderAccount);
await page.waitForFunction(() => globalThis.__pandaForceDebug.state.account !== null);
await page.waitForFunction(() => globalThis.__pandaForceDebug.state.connected);
await page.evaluate(() => globalThis.__pandaForceDebug.loadInitial());

await page.evaluate(() => {
  const api = globalThis.__pandaForceDebug;
  api.renderAccount({
    type: "chatgpt",
    displayName: "Desktop User",
    avatarUrl: null,
    planType: "plus",
    initials: "DU",
  });
  api.setPermissionProfiles([
    { id: ":read-only", description: null, allowed: true },
    { id: ":workspace", description: null, allowed: true },
    { id: ":danger-full-access", description: null, allowed: true },
    { id: "custom", description: "Reserved fixed mode", allowed: true },
    { id: "team-safe", description: "Team workspace profile", allowed: true },
    { id: "TEAM-SAFE", description: "Duplicate managed profile", allowed: true },
    { id: "managed-blocked", description: "Managed profile", allowed: false },
  ]);
});
await page.click("#accountButton");
const chatgpt = await page.evaluate(() => ({
  product: document.querySelector("#productModeButton strong")?.textContent.trim(),
  newChat: document.querySelector("#newTask span:nth-child(2)")?.textContent.trim(),
  search: document.querySelector("#threadSearch")?.placeholder,
  projects: document.querySelector("#projectButton")?.textContent.trim(),
  footerName: document.querySelector("#accountName")?.textContent.trim(),
  footerMeta: document.querySelector("#accountFooterMeta")?.textContent.trim(),
  buttonLabel: document.querySelector("#accountButton")?.getAttribute("aria-label"),
  profileHidden: document.querySelector("#accountProfile")?.hidden,
  usageHidden: document.querySelector("#accountUsage")?.hidden,
  logoutHidden: document.querySelector("#accountLogout")?.hidden,
}));
await page.click("#accountSettings");
await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
const settingsShell = await page.evaluate(() => ({
  groups: [...document.querySelectorAll("[data-settings-group] summary")].map((node) => node.textContent.trim()),
  pages: [...document.querySelectorAll("[data-settings-page]")].map((node) => node.textContent.trim()),
  fullPage: getComputedStyle(document.querySelector("#settingsDialog")).position === "fixed",
  back: document.querySelector("#closeSettingsNav")?.textContent.trim(),
  route: location.pathname,
  modal: document.querySelector("#settingsDialog").matches(":modal"),
  navSpacer: document.querySelector(".settings-nav-toolbar-spacer")?.getBoundingClientRect().height,
}));
await page.locator("[data-settings-group]").evaluateAll((groups) => groups.forEach((group) => (group.open = true)));
await page.click('[data-settings-page="agent"]');
const configuration = await page.evaluate(() => ({
  title: document.querySelector(".settings-page:not([hidden]) h1")?.textContent.trim(),
  route: location.pathname,
  values: [...document.querySelectorAll("#settingsPlaceholderRows .settings-row")].map((node) =>
    node.textContent.trim(),
  ),
}));
await page.fill("#settingsSearch", "browser");
const settingsSearch = await page.evaluate(() => ({
  visible: [...document.querySelectorAll("[data-settings-page]")]
    .filter((node) => !node.hidden)
    .map((node) => node.textContent.trim()),
  groups: [...document.querySelectorAll("[data-settings-group]")]
    .filter((node) => !node.hidden)
    .map((node) => node.querySelector("summary")?.textContent.trim()),
  clearVisible: !document.querySelector("#clearSettingsSearch").hidden,
}));
await page.locator("[data-settings-group]").evaluateAll((groups) => groups.forEach((group) => (group.open = true)));
await page.click('[data-settings-page="browser-use"]');
await page.screenshot({ path: "/tmp/panda-force-settings-shell.png" });
await page.click("#clearSettingsSearch");
await page.locator("[data-settings-group]").evaluateAll((groups) => groups.forEach((group) => (group.open = true)));
await page.click('[data-settings-page="general-settings"]');
const settings = await page.evaluate(() => ({
  open: document.querySelector("#settingsDialog").open,
  title: document.querySelector("#settingsTitle")?.textContent.trim(),
  page: document.querySelector("#settingsPageTitle")?.textContent.trim(),
  permission: document.querySelector("#settingsPermissionValue")?.textContent.trim(),
  autoReviewHidden: document.querySelector("#settingsAutoReviewRow")?.hidden,
  autoReviewChecked: document.querySelector("#settingsAutoReviewToggle")?.checked,
  fullAccessChecked: document.querySelector("#settingsFullAccessToggle")?.checked,
}));
await page.click("#closeSettingsNav");
await page.waitForFunction(
  () => !document.querySelector("#settingsDialog").open && ["/workspace", "/"].includes(location.pathname),
);

await page.click("#modeButton");
const permissionMenu = await page.evaluate(() => ({
  open: !document.querySelector("#permissionMenu").hidden,
  options: [...document.querySelectorAll("[data-permission-mode] strong")].map((node) => node.textContent.trim()),
  blockedDisabled: document.querySelector('[data-permission-mode="profile:managed-blocked"]')?.disabled,
}));
await page.screenshot({ path: "/tmp/panda-force-permissions-menu.png" });

await page.click('[data-permission-mode="guardian-approvals"]');
const guardian = await page.evaluate(() => ({
  selected: globalThis.__pandaForceDebug.selectedPermission(),
  thread: globalThis.__pandaForceDebug.permissionThreadPolicy(),
  turn: globalThis.__pandaForceDebug.permissionTurnPolicy("/tmp/project"),
}));

await page.click("#modeButton");
await page.click('[data-permission-mode="profile:team-safe"]');
const profile = await page.evaluate(() => ({
  selected: globalThis.__pandaForceDebug.selectedPermission(),
  thread: globalThis.__pandaForceDebug.permissionThreadPolicy(),
  turn: globalThis.__pandaForceDebug.permissionTurnPolicy("/tmp/project"),
}));

await page.click("#modeButton");
await page.click('[data-permission-mode="full-access"]');
await page.waitForFunction(() => document.querySelector("#fullAccessDialog").open);
const fullAccessDialog = await page.evaluate(() => {
  const dialog = document.querySelector("#fullAccessDialog"),
    rect = dialog.getBoundingClientRect();
  return {
    modal: dialog.matches(":modal"),
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    viewportX: innerWidth / 2,
    viewportY: innerHeight / 2,
  };
});
await page.screenshot({ path: "/tmp/panda-force-full-access-dialog.png" });
await page.click("#confirmFullAccess");
const fullAccess = await page.evaluate(() => ({
  label: document.querySelector("#modeButton .control-label").textContent.trim(),
  mode: globalThis.__pandaForceDebug.state.permissionMode,
  selected: globalThis.__pandaForceDebug.selectedPermission(),
  thread: globalThis.__pandaForceDebug.permissionThreadPolicy(),
  turn: globalThis.__pandaForceDebug.permissionTurnPolicy("/tmp/project"),
}));

await page.click("#accountButton");
await page.click("#accountSettings");
await page.click("#settingsFullAccessRow .settings-switch");
const fullAccessSettingOff = await page.evaluate(() => ({
  checked: document.querySelector("#settingsFullAccessToggle").checked,
  mode: globalThis.__pandaForceDebug.state.permissionMode,
  visible: globalThis.__pandaForceDebug.state.permissionVisibility.fullAccess,
}));
await page.click("#settingsFullAccessRow .settings-switch");
await page.waitForFunction(() => document.querySelector("#fullAccessDialog").open);
await page.click("#confirmFullAccess");
const fullAccessSettingOn = await page.evaluate(() => ({
  checked: document.querySelector("#settingsFullAccessToggle").checked,
  mode: globalThis.__pandaForceDebug.state.permissionMode,
  visible: globalThis.__pandaForceDebug.state.permissionVisibility.fullAccess,
}));
await page.click("#closeSettingsNav");
await page.waitForFunction(
  () => !document.querySelector("#settingsDialog").open && ["/workspace", "/"].includes(location.pathname),
);

await page.evaluate(() =>
  globalThis.__pandaForceDebug.renderAccount({
    type: "apiKey",
    displayName: "API key",
    avatarUrl: null,
    planType: null,
    initials: "AP",
  }),
);
await page.click("#accountButton");
await page.waitForFunction(() => document.querySelector("#settingsDialog").open);
const apiKey = await page.evaluate(() => ({
  footerName: document.querySelector("#accountName")?.textContent.trim(),
  footerMeta: document.querySelector("#accountFooterMeta")?.textContent.trim(),
  profileHidden: document.querySelector("#accountProfile")?.hidden,
  usageHidden: document.querySelector("#accountUsage")?.hidden,
  settingsHidden: document.querySelector("#accountSettings")?.hidden,
  logoutHidden: document.querySelector("#accountLogout")?.hidden,
  avatarClass: document.querySelector("#accountAvatar")?.className,
  avatarIcon: document.querySelectorAll("#accountAvatar svg").length,
  buttonLabel: document.querySelector("#accountButton")?.getAttribute("aria-label"),
}));
const apiSettings = await page.evaluate(() => ({
  autoReviewHidden: document.querySelector("#settingsAutoReviewRow")?.hidden,
  selectedMode: globalThis.__pandaForceDebug.state.permissionMode,
}));
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: "/tmp/panda-force-settings-mobile.png" });
const mobileSettings = await page.evaluate(() => ({
  dialog: document.querySelector("#settingsDialog").getBoundingClientRect().toJSON(),
  viewport: { width: innerWidth, height: innerHeight },
  horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  pageVisible: document.querySelector("#settingsDialog").dataset.mobilePage,
  navWidth: document.querySelector(".settings-nav").getBoundingClientRect().width,
  contentWidth: document.querySelector(".settings-content").getBoundingClientRect().width,
}));
await page.click("#settingsMobileBack");
const mobileSettingsNavigation = await page.evaluate(() => ({
  pageVisible: document.querySelector("#settingsDialog").dataset.mobilePage,
  navWidth: document.querySelector(".settings-nav").getBoundingClientRect().width,
  contentWidth: document.querySelector(".settings-content").getBoundingClientRect().width,
}));

const directPage = await context.newPage();
directPage.setDefaultTimeout(7000);
await directPage.goto(new URL("/settings/browser-use", base).href, { waitUntil: "networkidle" });
await directPage.waitForFunction(() => document.querySelector("#settingsDialog")?.open);
const directSettings = await directPage.evaluate(() => ({
  route: location.pathname,
  title: document.querySelector(".settings-page:not([hidden]) h1")?.textContent.trim(),
  modal: document.querySelector("#settingsDialog").matches(":modal"),
}));
await directPage.click("#closeSettingsNav");
await directPage.waitForFunction(
  () => !document.querySelector("#settingsDialog").open && ["/workspace", "/"].includes(location.pathname),
);
directSettings.closedRoute = await directPage.evaluate(() => location.pathname);
await directPage.close();

console.log(
  JSON.stringify(
    {
      chatgpt,
      settingsShell,
      configuration,
      settingsSearch,
      settings,
      permissionMenu,
      guardian,
      profile,
      fullAccessDialog,
      fullAccess,
      fullAccessSettingOff,
      fullAccessSettingOn,
      apiKey,
      apiSettings,
      mobileSettings,
      mobileSettingsNavigation,
      directSettings,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.equal(chatgpt.product, "PandaForce", "Condition: chatgpt.product!=='PandaForce'");
  qualityAssert.equal(chatgpt.newChat, "New session", "Condition: chatgpt.newChat!=='New session'");
  qualityAssert.equal(chatgpt.search, "Search sessions", "Condition: chatgpt.search!=='Search sessions'");
  qualityAssert.equal(chatgpt.projects, "Projects", "Condition: chatgpt.projects!=='Projects'");
  qualityAssert.equal(chatgpt.footerName, "Desktop User", "Condition: chatgpt.footerName!=='Desktop User'");
  qualityAssert.equal(chatgpt.footerMeta, "", "Condition: chatgpt.footerMeta!==''");
  qualityAssert.equal(chatgpt.buttonLabel, "Open profile menu", "Condition: chatgpt.buttonLabel!=='Open profile menu'");
  qualityAssert.ok(!chatgpt.profileHidden, "Condition: chatgpt.profileHidden");
  qualityAssert.ok(!chatgpt.usageHidden, "Condition: chatgpt.usageHidden");
  qualityAssert.ok(!chatgpt.logoutHidden, "Condition: chatgpt.logoutHidden");
  qualityAssert.equal(settingsShell.groups.length, 5, "Condition: settingsShell.groups.length!==5");
  qualityAssert.ok(
    settingsShell.pages.includes("Configuration"),
    "Condition: !settingsShell.pages.includes('Configuration')",
  );
  qualityAssert.ok(
    settingsShell.pages.includes("Cloud preferences"),
    "Condition: !settingsShell.pages.includes('Cloud preferences')",
  );
  qualityAssert.ok(settingsShell.fullPage, "Condition: !settingsShell.fullPage");
  qualityAssert.equal(settingsShell.back, "Back to app", "Condition: settingsShell.back!=='Back to app'");
  qualityAssert.equal(
    settingsShell.route,
    "/settings/general-settings",
    "Condition: settingsShell.route!=='/settings/general-settings'",
  );
  qualityAssert.ok(settingsShell.modal, "Condition: !settingsShell.modal");
  qualityAssert.equal(settingsShell.navSpacer, 46, "Condition: settingsShell.navSpacer!==46");
  qualityAssert.equal(configuration.title, "Configuration", "Condition: configuration.title!=='Configuration'");
  qualityAssert.equal(configuration.route, "/settings/agent", "Condition: configuration.route!=='/settings/agent'");
  qualityAssert.ok(
    configuration.values.some((value) => value.startsWith("Model")),
    "Condition: !configuration.values.some(value=>value.startsWith('Model'))",
  );
  qualityAssert.equal(
    settingsSearch.visible.join("|"),
    "Browser",
    "Condition: settingsSearch.visible.join('|')!=='Browser'",
  );
  qualityAssert.equal(
    settingsSearch.groups.join("|"),
    "Engines and tools",
    "Condition: settingsSearch.groups.join('|')!=='Engines and tools'",
  );
  qualityAssert.ok(settingsSearch.clearVisible, "Condition: !settingsSearch.clearVisible");
  qualityAssert.ok(settings.open, "Condition: !settings.open");
  qualityAssert.equal(settings.title, "Settings", "Condition: settings.title!=='Settings'");
  qualityAssert.equal(settings.page, "General", "Condition: settings.page!=='General'");
  qualityAssert.equal(settings.permission, "Ask for approval", "Condition: settings.permission!=='Ask for approval'");
  qualityAssert.ok(settings.autoReviewHidden, "Condition: !settings.autoReviewHidden");
  qualityAssert.ok(settings.autoReviewChecked, "Condition: !settings.autoReviewChecked");
  qualityAssert.ok(settings.fullAccessChecked, "Condition: !settings.fullAccessChecked");
  qualityAssert.ok(permissionMenu.open, "Condition: !permissionMenu.open");
  qualityAssert.equal(
    permissionMenu.options.join("|"),
    "Ask for approval|Approve for me|Full access|team-safe|managed-blocked",
    "Condition: permissionMenu.options.join('|')!=='Ask for approval|Approve for me|Full access|team-safe|managed-blocked'",
  );
  qualityAssert.ok(permissionMenu.blockedDisabled, "Condition: !permissionMenu.blockedDisabled");
  qualityAssert.equal(
    guardian.selected.approvalsReviewer,
    "auto_review",
    "Condition: guardian.selected.approvalsReviewer!=='auto_review'",
  );
  qualityAssert.equal(
    guardian.thread.approvalPolicy,
    "on-request",
    "Condition: guardian.thread.approvalPolicy!=='on-request'",
  );
  qualityAssert.equal(
    guardian.thread.approvalsReviewer,
    "auto_review",
    "Condition: guardian.thread.approvalsReviewer!=='auto_review'",
  );
  qualityAssert.equal(
    guardian.thread.sandbox,
    "workspace-write",
    "Condition: guardian.thread.sandbox!=='workspace-write'",
  );
  qualityAssert.equal(
    guardian.turn.approvalsReviewer,
    "auto_review",
    "Condition: guardian.turn.approvalsReviewer!=='auto_review'",
  );
  qualityAssert.equal(
    guardian.turn.sandboxPolicy.type,
    "workspaceWrite",
    "Condition: guardian.turn.sandboxPolicy.type!=='workspaceWrite'",
  );
  qualityAssert.equal(guardian.turn.permissions, null, "Condition: guardian.turn.permissions!==null");
  qualityAssert.equal(profile.selected.profileId, "team-safe", "Condition: profile.selected.profileId!=='team-safe'");
  qualityAssert.equal(profile.thread.permissions, "team-safe", "Condition: profile.thread.permissions!=='team-safe'");
  qualityAssert.equal(Object.keys(profile.thread).length, 1, "Condition: Object.keys(profile.thread).length!==1");
  qualityAssert.equal(profile.turn.permissions, "team-safe", "Condition: profile.turn.permissions!=='team-safe'");
  qualityAssert.equal(profile.turn.approvalPolicy, null, "Condition: profile.turn.approvalPolicy!==null");
  qualityAssert.equal(profile.turn.approvalsReviewer, null, "Condition: profile.turn.approvalsReviewer!==null");
  qualityAssert.ok(!("sandboxPolicy" in profile.turn), "Condition: 'sandboxPolicy' in profile.turn");
  qualityAssert.ok(fullAccessDialog.modal, "Condition: !fullAccessDialog.modal");
  qualityAssert.ok(
    !(Math.abs(fullAccessDialog.centerX - fullAccessDialog.viewportX) > 1),
    "Condition: Math.abs(fullAccessDialog.centerX-fullAccessDialog.viewportX)>1",
  );
  qualityAssert.ok(
    !(Math.abs(fullAccessDialog.centerY - fullAccessDialog.viewportY) > 1),
    "Condition: Math.abs(fullAccessDialog.centerY-fullAccessDialog.viewportY)>1",
  );
  qualityAssert.equal(fullAccess.label, "Full access", "Condition: fullAccess.label!=='Full access'");
  qualityAssert.equal(fullAccess.mode, "full-access", "Condition: fullAccess.mode!=='full-access'");
  qualityAssert.equal(
    fullAccess.selected.approvalPolicy,
    "never",
    "Condition: fullAccess.selected.approvalPolicy!=='never'",
  );
  qualityAssert.equal(
    fullAccess.selected.sandbox,
    "danger-full-access",
    "Condition: fullAccess.selected.sandbox!=='danger-full-access'",
  );
  qualityAssert.equal(
    fullAccess.thread.approvalPolicy,
    "never",
    "Condition: fullAccess.thread.approvalPolicy!=='never'",
  );
  qualityAssert.equal(
    fullAccess.thread.approvalsReviewer,
    "user",
    "Condition: fullAccess.thread.approvalsReviewer!=='user'",
  );
  qualityAssert.equal(
    fullAccess.thread.sandbox,
    "danger-full-access",
    "Condition: fullAccess.thread.sandbox!=='danger-full-access'",
  );
  qualityAssert.equal(
    fullAccess.turn.sandboxPolicy.type,
    "dangerFullAccess",
    "Condition: fullAccess.turn.sandboxPolicy.type!=='dangerFullAccess'",
  );
  qualityAssert.ok(!fullAccessSettingOff.checked, "Condition: fullAccessSettingOff.checked");
  qualityAssert.ok(!fullAccessSettingOff.visible, "Condition: fullAccessSettingOff.visible");
  qualityAssert.equal(fullAccessSettingOff.mode, "default", "Condition: fullAccessSettingOff.mode!=='default'");
  qualityAssert.ok(fullAccessSettingOn.checked, "Condition: !fullAccessSettingOn.checked");
  qualityAssert.ok(fullAccessSettingOn.visible, "Condition: !fullAccessSettingOn.visible");
  qualityAssert.equal(fullAccessSettingOn.mode, "default", "Condition: fullAccessSettingOn.mode!=='default'");
  qualityAssert.equal(apiKey.footerName, "API key", "Condition: apiKey.footerName!=='API key'");
  qualityAssert.equal(apiKey.footerMeta, "", "Condition: apiKey.footerMeta!==''");
  qualityAssert.equal(apiKey.buttonLabel, "Open settings", "Condition: apiKey.buttonLabel!=='Open settings'");
  qualityAssert.equal(
    apiKey.avatarClass,
    "account-avatar account-settings-icon",
    "Condition: apiKey.avatarClass!=='account-avatar account-settings-icon'",
  );
  qualityAssert.equal(apiKey.avatarIcon, 1, "Condition: apiKey.avatarIcon!==1");
  qualityAssert.ok(apiKey.profileHidden, "Condition: !apiKey.profileHidden");
  qualityAssert.ok(apiKey.usageHidden, "Condition: !apiKey.usageHidden");
  qualityAssert.ok(!apiKey.settingsHidden, "Condition: apiKey.settingsHidden");
  qualityAssert.ok(apiKey.logoutHidden, "Condition: !apiKey.logoutHidden");
  qualityAssert.ok(apiSettings.autoReviewHidden, "Condition: !apiSettings.autoReviewHidden");
  qualityAssert.ok(!mobileSettings.horizontalOverflow, "Condition: mobileSettings.horizontalOverflow");
  qualityAssert.equal(
    mobileSettings.dialog.width,
    mobileSettings.viewport.width,
    "Condition: mobileSettings.dialog.width!==mobileSettings.viewport.width",
  );
  qualityAssert.equal(mobileSettings.pageVisible, "true", "Condition: mobileSettings.pageVisible!=='true'");
  qualityAssert.equal(mobileSettings.navWidth, 0, "Condition: mobileSettings.navWidth!==0");
  qualityAssert.equal(
    mobileSettings.contentWidth,
    mobileSettings.viewport.width,
    "Condition: mobileSettings.contentWidth!==mobileSettings.viewport.width",
  );
  qualityAssert.equal(
    mobileSettingsNavigation.pageVisible,
    "false",
    "Condition: mobileSettingsNavigation.pageVisible!=='false'",
  );
  qualityAssert.equal(
    mobileSettingsNavigation.navWidth,
    mobileSettings.viewport.width,
    "Condition: mobileSettingsNavigation.navWidth!==mobileSettings.viewport.width",
  );
  qualityAssert.equal(mobileSettingsNavigation.contentWidth, 0, "Condition: mobileSettingsNavigation.contentWidth!==0");
  qualityAssert.equal(
    directSettings.route,
    "/settings/browser-use",
    "Condition: directSettings.route!=='/settings/browser-use'",
  );
  qualityAssert.equal(directSettings.title, "Browser", "Condition: directSettings.title!=='Browser'");
  qualityAssert.ok(directSettings.modal, "Condition: !directSettings.modal");
  qualityAssert.equal(directSettings.closedRoute, "/workspace", "Condition: directSettings.closedRoute!=='/workspace'");
}
