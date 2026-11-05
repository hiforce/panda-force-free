import qualityAssert from "node:assert/strict";
import { createBrowserFixture } from "../support/browser-runtime.mjs";

import { artifact, launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture();

const base = runtime.base;
const browser = await runtime.launchBrowser(launchOptions());
const context = await browser.newContext({ viewport: { width: 1120, height: 760 }, colorScheme: "dark" });
await context.addInitScript(() => {
  if (window === window.top) localStorage.setItem("panda-force-locale", "zh-CN");
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__pandaForceDebug?.openSettings);
await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
await page.evaluate(() => {
  globalThis.__pandaForceDebug.startNewTask();
  const effort = document.querySelector("#effortSelect");
  effort.innerHTML = '<option value="low" selected>low</option>';
  globalThis.__pandaForceI18n.setPreference("zh-CN");
  const message = document.createElement("div");
  message.id = "i18nContentProbe";
  message.className = "message-text";
  message.textContent = "Settings Running command";
  document.body.append(message);
  globalThis.__pandaForceDebug.openSettings("general-settings");
});
await page.waitForFunction(
  () =>
    document.querySelector("#settingsDialog")?.open &&
    document.querySelector("#settingsPageTitle")?.textContent === "通用",
);

const chinese = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  preference: localStorage.getItem("panda-force-locale"),
  newChat: document.querySelector("#newTask span:nth-child(2)")?.textContent.trim(),
  threadTitle: document.querySelector("#threadTitle")?.textContent.trim(),
  settings: document.querySelector("#settingsTitle")?.textContent.trim(),
  page: document.querySelector("#settingsPageTitle")?.textContent.trim(),
  language: document.querySelector("#languageSelect")?.value,
  systemOption: document.querySelector('#languageSelect option[value="system"]')?.textContent.trim(),
  effort: document.querySelector("#effortLabel")?.textContent.trim(),
  content: document.querySelector("#i18nContentProbe")?.textContent,
}));
await page.screenshot({ path: artifact("i18n-zh-cn.png"), fullPage: false });

await page.evaluate(() => globalThis.__pandaForceDebug.openSettings("appearance"));
await page.selectOption("#languageSelect", "en");
await page.waitForFunction(
  () =>
    document.documentElement.lang === "en" &&
    document.querySelector("#settingsPageTitle")?.textContent === "Appearance",
);
const english = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  preference: localStorage.getItem("panda-force-locale"),
  newChat: document.querySelector("#newTask span:nth-child(2)")?.textContent.trim(),
  threadTitle: document.querySelector("#threadTitle")?.textContent.trim(),
  page: document.querySelector("#settingsPageTitle")?.textContent.trim(),
  language: document.querySelector("#languageSelect")?.value,
  effort: document.querySelector("#effortLabel")?.textContent.trim(),
  content: document.querySelector("#i18nContentProbe")?.textContent,
}));

await page.selectOption("#languageSelect", "zh-CN");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__pandaForceDebug && document.documentElement.lang === "zh-CN");
const persisted = await page.evaluate(() => ({
  lang: document.documentElement.lang,
  preference: localStorage.getItem("panda-force-locale"),
  language: document.querySelector("#languageSelect")?.value,
  page: document.querySelector("#settingsPageTitle")?.textContent.trim(),
}));

console.log(JSON.stringify({ chinese, english, persisted, errors }, null, 2));
await browser.close();
{
  qualityAssert.ok(!errors.length, "Condition: errors.length");
  qualityAssert.equal(chinese.lang, "zh-CN", "Condition: chinese.lang!=='zh-CN'");
  qualityAssert.equal(chinese.preference, "zh-CN", "Condition: chinese.preference!=='zh-CN'");
  qualityAssert.equal(chinese.newChat, "新建会话", "Condition: chinese.newChat!=='新建会话'");
  qualityAssert.equal(chinese.threadTitle, "新建会话", "Condition: chinese.threadTitle!=='新建会话'");
  qualityAssert.equal(chinese.settings, "设置", "Condition: chinese.settings!=='设置'");
  qualityAssert.equal(chinese.page, "通用", "Condition: chinese.page!=='通用'");
  qualityAssert.equal(chinese.language, "zh-CN", "Condition: chinese.language!=='zh-CN'");
  qualityAssert.equal(chinese.systemOption, "跟随系统", "Condition: chinese.systemOption!=='跟随系统'");
  qualityAssert.equal(chinese.effort, "低", "Condition: chinese.effort!=='低'");
  qualityAssert.equal(
    chinese.content,
    "Settings Running command",
    "Condition: chinese.content!=='Settings Running command'",
  );
  qualityAssert.equal(english.lang, "en", "Condition: english.lang!=='en'");
  qualityAssert.equal(english.preference, "en", "Condition: english.preference!=='en'");
  qualityAssert.equal(english.newChat, "New session", "Condition: english.newChat!=='New session'");
  qualityAssert.equal(english.threadTitle, "New session", "Condition: english.threadTitle!=='New session'");
  qualityAssert.equal(english.page, "Appearance", "Condition: english.page!=='Appearance'");
  qualityAssert.equal(english.language, "en", "Condition: english.language!=='en'");
  qualityAssert.equal(english.effort, "Low", "Condition: english.effort!=='Low'");
  qualityAssert.equal(
    english.content,
    "Settings Running command",
    "Condition: english.content!=='Settings Running command'",
  );
  qualityAssert.equal(persisted.lang, "zh-CN", "Condition: persisted.lang!=='zh-CN'");
  qualityAssert.equal(persisted.preference, "zh-CN", "Condition: persisted.preference!=='zh-CN'");
  qualityAssert.equal(persisted.language, "zh-CN", "Condition: persisted.language!=='zh-CN'");
  qualityAssert.equal(persisted.page, "外观", "Condition: persisted.page!=='外观'");
}
