import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_FORCE_HARNESS_COMPOSER_PROOF || ".artifacts/harness-active-composer";
await mkdir(output, { recursive: true });

for (const [engine, width, locale, hint] of [
  [chromium, 1440, "en", "Send after this reply"],
  [webkit, 390, "zh-CN", "等本轮回复结束后发送"],
  [webkit, 390, "zh-HK", "等這輪回覆結束後再傳送"],
  [webkit, 390, "zh-TW", "等這一輪回覆結束後再傳送"],
]) {
  const app = await createAppFixture({
    startupTimeoutMs: 60000,
    async prepareState({ dir }) {
      const home = join(dir, "antigravity-account");
      await mkdir(home);
      await writeFile(join(home, "signed-in"), "");
    },
    extraEnvironment: ({ dir }) => ({
      PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES: JSON.stringify([
        {
          id: "antigravity",
          name: "Antigravity CLI",
          accountHome: join(dir, "antigravity-account"),
          command: new URL("../support/antigravity-acp-fixture.mjs", import.meta.url).pathname,
        },
      ]),
    }),
  });
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    await app.signIn(context);
    await context.addInitScript((language) => {
      if (window === window.top) localStorage.setItem("panda-force-locale", language);
    }, locale);
    const conversations = app.base + "/api/personal/harness/conversations";
    const created = await context.request.post(conversations, {
      headers: { Origin: app.base },
      data: { runtimeId: "antigravity" },
    });
    assert.equal(created.status(), 201);
    const id = (await created.json()).conversation.id;
    const page = await context.newPage();
    const actions = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url() === `${conversations}/${id}/runs`) actions.push("send");
      if (request.url() === `${conversations}/${id}/cancel`) actions.push("stop");
    });
    await page.goto(app.base + "/task/" + encodeURIComponent("harness:" + id));
    const prompt = page.locator("#prompt");
    const button = page.locator("#sendButton");
    const waiting = page.locator("#composerTurnWait");
    const mode = (value) => page.locator(`#sendButton[data-submit-mode="${value}"]:enabled`).waitFor();
    const serverStatus = (status) =>
      waitFor(async () => {
        const snapshot = await (await context.request.get(`${conversations}/${id}`)).json();
        return snapshot.run?.status === status;
      });

    await prompt.fill("antigravity.approval");
    await button.click();
    const approve = page.locator('[data-harness-permission][data-harness-option="yes"]');
    await approve.waitFor();
    await mode("stop");
    await prompt.fill("Follow up once the reply finishes.");
    await waiting.waitFor();
    assert.match(await waiting.textContent(), new RegExp(hint));
    assert.equal(await prompt.getAttribute("aria-describedby"), "composerTurnWait");
    await prompt.press("Enter");
    await prompt.press("Tab");
    assert.equal(await prompt.evaluate((node) => document.activeElement === node), false);
    assert.equal(await prompt.inputValue(), "Follow up once the reply finishes.");
    assert.deepEqual(actions, ["send"]);
    assert.equal(await page.locator('#conversation [data-steer="true"]').count(), 0);
    await page.screenshot({ path: join(output, `${locale}-${width}.png`), scale: "css" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await approve.click();
    await serverStatus("complete");
    await mode("send");
    await waiting.waitFor({ state: "hidden" });
    assert.equal(await prompt.inputValue(), "Follow up once the reply finishes.");
    await prompt.press("Enter");
    await page.getByText("Antigravity reply (high).", { exact: true }).first().waitFor();
    await mode("send");

    await prompt.fill("antigravity.hold");
    await button.click();
    await serverStatus("running");
    await mode("stop");
    await prompt.fill("Follow up after stopping.");
    await waiting.waitFor();
    await button.click();
    await serverStatus("cancelled");
    await mode("send");
    assert.equal(await prompt.inputValue(), "Follow up after stopping.");
    await button.click();
    await serverStatus("complete");
    assert.deepEqual(actions, ["send", "send", "send", "stop", "send"]);
    assert.deepEqual(errors, []);
    console.log(`Managed composer passed for ${locale} at ${width}px.`);
  } finally {
    await browser.close();
    await app.dispose();
  }
}
