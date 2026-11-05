import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const artifacts = resolve(root, ".artifacts");
mkdirSync(artifacts, { recursive: true });

export function launchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const executablePath = candidates.find((path) => path && existsSync(path));
  return executablePath && existsSync(executablePath) ? { headless: true, executablePath } : { headless: true };
}

export function artifact(name) {
  return resolve(artifacts, name);
}

// Application tests own their authenticated backend and browser lifecycle.
// Auth-page and standalone component tests may still use Playwright directly.
export async function createBrowserFixture(options = {}) {
  const { createAppFixture } = await import("./app-fixture.mjs");
  const fixture = await createAppFixture({
    models: [
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "5.6 Sol",
        isDefault: true,
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
          reasoningEffort,
        })),
      },
      {
        id: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        displayName: "5.6 Luna",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
      },
    ],
    ...options,
  });
  const browsers = new Set();
  const dispose = fixture.dispose.bind(fixture);
  fixture.dispose = async () => {
    for (const browser of browsers) await browser.close().catch(() => {});
    browsers.clear();
    await dispose();
  };
  fixture.launchBrowser = async (launch = launchOptions()) => {
    const { chromium } = await import("playwright");
    const actual = await chromium.launch(launch);
    browsers.add(actual);
    const context = async (settings = {}) => {
      const value = await actual.newContext(settings);
      await fixture.signIn(value);
      await value.addInitScript(() => {
        if (window === window.top) localStorage.setItem("panda-force-locale", "en");
      });
      return value;
    };
    return new Proxy(actual, {
      get(target, key) {
        if (key === "newContext") return context;
        if (key === "newPage") return async (settings) => (await context(settings)).newPage();
        if (key === "close")
          return async () => {
            browsers.delete(actual);
            await actual.close();
            await fixture.dispose();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return fixture;
}
