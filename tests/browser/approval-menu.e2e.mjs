import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
let browser;
try {
  browser = await chromium.launch(launchOptions());
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      ...(mobile ? devices["iPhone 13"] : {}),
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      colorScheme: mobile ? "dark" : "light",
    });
    context.setDefaultTimeout(10_000);
    await fixture.signIn(context);
    await context.addInitScript(() => {
      if (window === window.top) localStorage.setItem("panda-force-locale", "en");
    });
    const page = await context.newPage(),
      decisions = [],
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", async (response) => {
      if (response.url().endsWith("/api/engine/respond") && response.ok())
        decisions.push(response.request().postDataJSON());
    });
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
    // Use the real approval renderer while recording decisions instead of running a command.
    await page.evaluate(() => {
      const api = globalThis.__pandaForceDebug;
      api.state.ws?.close();
    });
    await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
    const prefix = mobile ? "mobile-" : "desktop-";
    let activeNativeRequest;
    const request = async (id, scoped = "session") => {
      activeNativeRequest = prefix + id;
      fixture.requestApproval({
        id: prefix + id,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "old-alpha",
          turnId: `approval-${prefix + id}`,
          itemId: `command-${prefix + id}`,
          command: "echo test",
          cwd: fixture.alpha,
          availableDecisions: ["accept", "decline", "acceptForSession"],
          ...(scoped === "similar" ? { proposedExecpolicyAmendment: ["echo"] } : {}),
        },
      });
      await page.locator(".approval-card .approval-scoped").waitFor();
    };
    const card = () => page.locator(".approval-card").last();
    const checkLayout = async () => {
      const layout = await card().evaluate((card) => {
        const buttons = [...card.querySelectorAll(".approval-actions-main > button")];
        return {
          classes: buttons.map((button) => button.className),
          bounds: buttons.map((button) => {
            const r = button.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
          }),
          danger: buttons.at(-1).classList.contains("danger"),
          dangerColor: getComputedStyle(buttons.at(-1)).color,
          scopedColor: getComputedStyle(buttons[1]).color,
        };
      });
      assert.ok(layout.classes[0].includes("approval-primary"));
      assert.ok(layout.classes[1].includes("approval-scoped"));
      assert.ok(layout.classes[2].includes("approval-deny"));
      assert.ok(layout.danger);
      assert.notEqual(layout.dangerColor, layout.scopedColor);
      for (const bounds of layout.bounds) {
        assert.ok(bounds.x >= 0 && bounds.right <= (mobile ? 390 : 1280));
        assert.ok(bounds.height >= 44);
        assert.ok(Math.abs(bounds.y - layout.bounds[0].y) < 1);
        assert.ok(Math.abs(bounds.width - layout.bounds[0].width) < 1);
        assert.ok(Math.abs(bounds.height - layout.bounds[0].height) < 1);
      }
      assert.equal(await card().locator(".approval-menu-toggle").count(), 0);
    };
    const decide = async (selector, expected) => {
      await card().locator(selector).click();
      await page.waitForFunction(() => document.querySelectorAll(".approval-card").length === 0);
      await waitFor(() => decisions.length);
      assert.deepEqual(decisions.pop().result, {
        choiceId: selector === ".approval-primary" ? "primary" : selector === ".approval-deny" ? "deny" : "scoped",
      });
      const native = await waitFor(() =>
        fixture.calls().find((call) => call.type === "response" && call.id === activeNativeRequest),
      );
      assert.deepEqual(native.result, expected);
    };
    await request(501);
    await checkLayout();
    const systemDanger = await card()
      .locator(".approval-deny")
      .evaluate((button) => getComputedStyle(button).color);
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), mobile ? "light" : "dark");
    await checkLayout();
    assert.notEqual(
      await card()
        .locator(".approval-deny")
        .evaluate((button) => getComputedStyle(button).color),
      systemDanger,
    );
    await page.evaluate(() => delete document.documentElement.dataset.theme);
    await checkLayout();
    await decide(".approval-scoped", { decision: "acceptForSession" });
    await request(502, "similar");
    await checkLayout();
    await page.screenshot({ path: artifact(mobile ? "approval-actions-mobile.png" : "approval-actions-desktop.png") });
    await card().locator(".approval-scoped").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".approval-card").length === 0);
    await waitFor(() => decisions.length);
    assert.deepEqual(decisions.pop().result, { choiceId: "scoped" });
    assert.deepEqual(
      (await waitFor(() => fixture.calls().find((call) => call.type === "response" && call.id === activeNativeRequest)))
        .result,
      {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } },
      },
    );
    await request(503);
    await decide(".approval-deny", { decision: "decline" });
    await request(504);
    await decide(".approval-primary", { decision: "accept" });
    await request(505);
    fixture.requestApproval({ method: "serverRequest/resolved", params: { requestId: prefix + 505 } });
    await page.waitForFunction(() => document.querySelectorAll(".approval-card").length === 0);
    await request(506);
    await page.evaluate(() => globalThis.__pandaForceDebug.startNewTask());
    assert.equal(decisions.length, 0);
    assert.deepEqual(errors, []);
    fixture.requestApproval({ method: "serverRequest/resolved", params: { requestId: prefix + 506 } });
    await context.close();
  }
  console.log(
    "Approval actions share one equal-width row, rejection uses danger styling, and allow/session/similar/deny decisions work on desktop and mobile.",
  );
} finally {
  await browser?.close();
  await fixture.dispose();
}
