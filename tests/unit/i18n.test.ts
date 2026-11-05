import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createI18n, createI18nRuntime, resolveLocale } from "../../src/client/i18n.js";
import { serverMessages } from "../../src/shared/i18n/server-catalogs.js";
const chineseMessages = serverMessages["zh-CN"];
import { SUPPORTED_LOCALES, parseLanguageHeader, readLocaleCookie } from "../../src/shared/i18n/locale-policy.js";
import { requestLocale } from "../../src/server/i18n/request-locale.js";
const loaders = { "zh-CN": async () => chineseMessages };

describe("locale policy", () => {
  test("explicit choices win; unset choices follow browser order with English fallback", () => {
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["zh-Hans-SG", "en"])).toBe("zh-CN");
    expect(resolveLocale("system", ["de-DE", "en-GB", "zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["zh-TW"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
  });
  test("new regions and scripts use registry data rather than new language branches", () => {
    const registry = [
      ...SUPPORTED_LOCALES,
      { code: "zh-TW", name: "繁體中文", direction: "ltr" },
      { code: "fr", name: "Français", direction: "ltr" },
    ];
    expect(resolveLocale("system", ["zh-Hant-HK", "en"], registry)).toBe("zh-TW");
    expect(resolveLocale("system", ["fr-CA", "en"], registry)).toBe("fr");
    expect(resolveLocale("system", ["zh-SG"], registry)).toBe("zh-CN");
  });
  test("headers, browser preferences and explicit cookies share a policy", () => {
    expect(parseLanguageHeader("en-US;q=0.9,zh-CN;q=1,fr;q=0,*;q=0.5,ja;q=2")).toEqual(["zh-CN", "en-US"]);
    expect(requestLocale({ headers: { "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8" } })).toBe("en");
    expect(requestLocale({ headers: { cookie: "panda-force-locale=zh-CN", "accept-language": "en-US" } })).toBe(
      "zh-CN",
    );
    expect(
      requestLocale({ headers: { cookie: "panda-force-locale=system", "accept-language": "zh-CN,en;q=0.8" } }),
    ).toBe("zh-CN");
    expect(readLocaleCookie("panda-force-locale=%3Cscript%3E")).toBeNull();
  });
});

describe("message runtime", () => {
  test("loads a language once and falls back to English on unavailable resources", async () => {
    let loads = 0;
    const runtime = createI18nRuntime({
      languages: ["zh-CN"],
      loaders: {
        "zh-CN": async () => {
          loads++;
          return chineseMessages;
        },
      },
    });
    await runtime.ready;
    expect(runtime.locale).toBe("zh-CN");
    expect(runtime.t("common.cancel")).toBe("取消");
    await runtime.setPreference("en");
    await runtime.setPreference("zh-CN");
    expect(loads).toBe(1);
    const broken = createI18nRuntime({
      languages: ["zh-CN"],
      loaders: {
        "zh-CN": async () => {
          throw new Error("offline");
        },
      },
    });
    await broken.ready;
    expect(broken.locale).toBe("en");
    expect(broken.t("common.cancel")).toBe("Cancel");
  });
  test("the latest language selection wins when an older download finishes later", async () => {
    let release: any;
    const runtime = createI18nRuntime({
      loaders: {
        "zh-CN": () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    await runtime.ready;
    const old = runtime.setPreference("zh-CN");
    await Promise.resolve();
    await runtime.setPreference("en");
    release(chineseMessages);
    await old;
    expect(runtime.locale).toBe("en");
    expect(runtime.preference).toBe("en");
  });
  test("isolated plugin namespaces support ICU plurals, selection and missing-language fallback", async () => {
    const runtime = createI18nRuntime({ loaders });
    await runtime.ready;
    await runtime.registerNamespace("plugin.demo", {
      en: {
        files: "{count, plural, =0 {No files} one {# file} other {# files}}",
        choice: "{mode, select, private {Private} other {Shared}}",
      },
      translations: { "zh-CN": { files: "{count, plural, =0 {没有文件} other {# 个文件}}" } },
    });
    expect(runtime.t("plugin.demo.files", { count: 0 })).toBe("No files");
    expect(runtime.t("plugin.demo.files", { count: 1 })).toBe("1 file");
    expect(runtime.t("plugin.demo.files", { count: 2 })).toBe("2 files");
    await runtime.setPreference("zh-CN");
    expect(runtime.t("plugin.demo.files", { count: 2 })).toBe("2 个文件");
    expect(runtime.t("plugin.demo.choice", { mode: "private" })).toBe("Private");
    await expect(runtime.registerNamespace("common", { en: {} })).rejects.toThrow();
    await expect(runtime.registerNamespace("plugin.demo", { en: {} })).rejects.toThrow();
  });
  test("formatting follows UI locale and an independent explicit timezone", async () => {
    const runtime = createI18nRuntime({ preference: "en", loaders, timeZone: "UTC" });
    await runtime.ready;
    expect(runtime.format.number(1234.5)).toBe("1,234.5");
    expect(runtime.format.dateTime(new Date("2026-01-01T00:00:00Z"), { hour: "2-digit", hourCycle: "h23" })).toBe("00");
    expect(runtime.format.compare("Project 2", "Project 10")).toBeLessThan(0);
    expect(runtime.format.currency(2, "USD")).toContain("2.00");
    expect(runtime.format.percent(0.2)).toBe("20%");
  });
});

describe("explicit bindings", () => {
  test("language changes preserve drafts, focus, raw content and editor DOM", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><button data-pf-message="common.settings" data-pf-title="common.openSettings">Settings</button><input id="draft" value="Settings"><article class="message-text">Settings Running command</article><pre><span id="code">Settings</span></pre></body></html>',
      { url: "http://localhost" },
    );
    const runtime = createI18n({
      document: dom.window.document,
      storage: dom.window.localStorage,
      languages: ["en"],
      loaders,
    });
    await runtime.ready;
    runtime.bindings.bind(dom.window.document);
    const input = dom.window.document.querySelector("input")!,
      code = dom.window.document.querySelector("#code")!;
    input.focus();
    input.setSelectionRange(2, 5);
    await runtime.setPreference("zh-CN");
    expect(dom.window.document.querySelector("button")!.textContent).toBe("设置");
    expect(dom.window.document.querySelector("button")!.title).toBe("打开设置");
    expect(dom.window.document.querySelector("article")!.textContent).toBe("Settings Running command");
    expect(dom.window.document.querySelector("#code")).toBe(code);
    expect(code.textContent).toBe("Settings");
    expect(input.value).toBe("Settings");
    expect(input.selectionStart).toBe(2);
    expect(dom.window.document.activeElement).toBe(input);
    expect(readLocaleCookie(dom.window.document.cookie)).toBe("zh-CN");
    await runtime.setPreference("en");
    expect(dom.window.document.querySelector("button")!.textContent).toBe("Settings");
    runtime.bindings.disconnect();
    dom.window.close();
  });
  test("a registered RTL locale controls language and direction without changing source text", async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><button data-pf-message="common.cancel">Cancel</button><pre dir="ltr">const value = 1;</pre></body></html>',
      { url: "http://localhost" },
    );
    const registry = [...SUPPORTED_LOCALES, { code: "ar", name: "العربية", direction: "rtl" }];
    const runtime = createI18n({
      document: dom.window.document,
      storage: dom.window.localStorage,
      languages: ["ar"],
      registry,
      resources: { ar: { common: { cancel: "إلغاء" } } },
      loaders: {},
    });
    await runtime.ready;
    runtime.bindings.bind(dom.window.document);
    expect(dom.window.document.documentElement.lang).toBe("ar");
    expect(dom.window.document.documentElement.dir).toBe("rtl");
    expect(dom.window.document.querySelector("button")!.textContent).toBe("إلغاء");
    expect(dom.window.document.querySelector("pre")!.textContent).toBe("const value = 1;");
    runtime.bindings.disconnect();
    dom.window.close();
  });
});

test("bad plugin contracts cannot overwrite resources; missing arguments never expose ICU templates", async () => {
  const runtime = createI18nRuntime({ loaders });
  await runtime.ready;
  await expect(
    runtime.registerNamespace("plugin.invalid", {
      en: { files: "{count, plural, one {# file} other {# files}}" },
      translations: { "zh-CN": { files: "{count}" } },
    }),
  ).rejects.toThrow("contract");
  await runtime.registerNamespace("plugin.invalid", { en: { files: "{count, plural, one {# file} other {# files}}" } });
  expect(runtime.t("plugin.invalid.files")).toBe("Message unavailable");
  expect(runtime.t("common.noSuchMessage")).toBe("Message unavailable");
  expect(runtime.t("Settings")).toBe("Settings");
  expect(runtime.t("remote image URLs are not supported; use an inline data URL instead")).toBe(
    "remote image URLs are not supported; use an inline data URL instead",
  );
});

test("language events respect manual choices and runtime cleanup removes listeners", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example" });
  const runtime = createI18n({
    document: dom.window.document,
    storage: dom.window.localStorage,
    languages: ["en"],
    loaders,
  });
  await runtime.ready;
  await runtime.setLanguages(["zh-CN", "en"]);
  expect(runtime.locale).toBe("zh-CN");
  await runtime.setPreference("en");
  Object.defineProperty(dom.window.navigator, "languages", { configurable: true, value: ["zh-CN"] });
  dom.window.dispatchEvent(new dom.window.Event("languagechange"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runtime.locale).toBe("en");
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "panda-force-locale", newValue: "zh-CN" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runtime.locale).toBe("zh-CN");
  runtime.dispose();
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "panda-force-locale", newValue: "en" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runtime.locale).toBe("zh-CN");
  dom.window.close();
});

test("owned errors carry stable IDs while CLI diagnostics remain opaque", async () => {
  const { errorPayload } = await import("../../src/server/i18n/error-payload.js");
  const { errorText } = await import("../../src/client/i18n/errors.js");
  const runtime = createI18nRuntime({ preference: "zh-CN", resources: { "zh-CN": chineseMessages } });
  await runtime.ready;
  const payload = errorPayload("auth.incorrectCredentials");
  expect(payload.error).toBe("Incorrect username or password");
  expect(errorText(payload, runtime.t)).toBe("用户名或密码不正确");
  expect(errorText({ error: "CLI: Settings failed" }, runtime.t)).toBe("CLI: Settings failed");
});

test("a reused title with user content is never restored to its old UI binding", async () => {
  const { setOpaqueText } = await import("../../src/client/i18n.js");
  const dom = new JSDOM(
    '<!doctype html><html><body><h1 data-pf-message="common.newSession">New session</h1></body></html>',
    { url: "https://fixture.example" },
  );
  const runtime = createI18n({
    document: dom.window.document,
    storage: dom.window.localStorage,
    languages: ["en"],
    loaders,
  });
  await runtime.ready;
  runtime.bindings.bind(dom.window.document);
  const heading = dom.window.document.querySelector("h1")!;
  setOpaqueText(heading, "My project Settings");
  runtime.bindings.bind(dom.window.document);
  await runtime.setPreference("zh-CN");
  expect(heading.textContent).toBe("My project Settings");
  runtime.dispose();
  dom.window.close();
});

test("pseudo messages expand owned labels while preserving ICU parameters and native data", async () => {
  const { pseudoCatalog } = await import("../../scripts/i18n/pseudo.mjs");
  const { messageContract } = await import("../../src/shared/i18n/message-contract.js");
  const { englishMessages } = await import("../../src/shared/i18n/catalogs.js");
  const pseudo = pseudoCatalog();
  for (const [domain, messages] of Object.entries(englishMessages))
    for (const [key, value] of Object.entries(messages))
      expect(messageContract(pseudo[domain][key])).toEqual(messageContract(value));
  const runtime = createI18nRuntime({
    preference: "en-XA",
    registry: [...SUPPORTED_LOCALES, { code: "en-XA", direction: "ltr", name: "Expanded test" }],
    resources: { "en-XA": pseudo },
  });
  await runtime.ready;
  expect(runtime.t("common.cancel").length).toBeGreaterThan("Cancel".length);
  expect(runtime.t("common.ranCommandWithCommand", { command: "cat Settings.txt" })).toContain("cat Settings.txt");
});

test("plugin dictionaries cannot leak into another runtime or the immutable core catalog", async () => {
  const { englishMessages } = await import("../../src/shared/i18n/catalogs.js");
  const first = createI18nRuntime(),
    second = createI18nRuntime();
  await Promise.all([first.ready, second.ready]);
  const messages = { label: "First plugin" };
  await first.registerNamespace("plugin.isolated", { en: messages });
  messages.label = "Changed outside the runtime";
  expect(first.t("plugin.isolated.label")).toBe("First plugin");
  expect(second.has("plugin.isolated.label")).toBe(false);
  expect(Object.hasOwn(englishMessages, "plugin.isolated")).toBe(false);
  await second.registerNamespace("plugin.isolated", { en: { label: "Second plugin" } });
  expect(first.t("plugin.isolated.label")).toBe("First plugin");
  expect(second.t("plugin.isolated.label")).toBe("Second plugin");
});
