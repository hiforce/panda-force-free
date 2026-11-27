import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { visibleHarnessText } from "../../src/shared/harness/text.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_FORCE_COLD_RESTORE_PROOF || ".artifacts/harness-consecutive-sends";
await mkdir(output, { recursive: true });
const records = [];
const inputs = [
  "The fixture project is Orion.",
  "Continue with Codex.",
  "Its release color is green.",
  "Recall those project details in Codex.",
  "Return to the release plan in Grok.",
];
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
]) {
  const app = await createAppFixture({
    completedTurnNotifications: true,
    rejectEphemeralResumes: true,
    extraEnvironment: ({ dir }) => ({
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-fixture",
          name: "Grok Fixture",
          accountHome: join(dir, "grok-account"),
          command: new URL("../support/grok-acp-fixture.mjs", import.meta.url).pathname,
        },
      ]),
    }),
  });
  const browser = await engine.launch();
  try {
    await mkdir(join(app.dir, "grok-account"));
    await writeFile(
      join(app.dir, "grok-account/auth.json"),
      JSON.stringify({ fixture: { access_token: "fixture-only" } }),
    );
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
      data: { runtimeId: "codex" },
    });
    assert.equal(created.status(), 201);
    const id = (await created.json()).conversation.id;
    const conversation = conversations + "/" + id;
    const bindings = () => {
      const metadata = new Database(join(app.dir, "panda-state/data/harness.sqlite"), { readonly: true });
      try {
        const row = metadata.query("SELECT data FROM harness_records WHERE id=?").get("conversation:" + id);
        return Object.fromEntries(
          JSON.parse(row.data).bindings.map((binding) => [binding.runtimeId, binding.nativeSessionId]),
        );
      } finally {
        metadata.close();
      }
    };
    // An existing binding from the temporary Codex implementation has no persisted rollout.
    const legacy = new Database(join(app.dir, "panda-state/data/harness.sqlite"));
    try {
      legacy.query("UPDATE harness_records SET data=json_set(data, '$.bindings', json(?)) WHERE id=?").run(
        JSON.stringify([
          {
            runtimeId: "codex",
            nativeSessionId: "old-ephemeral",
            scopeId: id,
            synchronizedSeq: 0,
            configurationRevision: 0,
          },
        ]),
        "conversation:" + id,
      );
    } finally {
      legacy.close();
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    let sends = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === conversation + "/runs") sends++;
    });
    await page.goto(app.base + "/task/" + encodeURIComponent("harness:" + id));
    const prompt = page.locator("#prompt");
    const send = page.locator('#sendButton[data-submit-mode="send"]:enabled');
    let final;
    async function sendTurn(message) {
      const previous = final?.run?.id;
      await prompt.fill(message);
      await send.click();
      await waitFor(async () => {
        const response = await context.request.get(conversation);
        assert.equal(response.status(), 200);
        final = await response.json();
        return final.run?.id !== previous && ["complete", "error", "uncertain"].includes(final.run?.status);
      });
      assert.equal(final.run.status, "complete", "Every send must complete on its first attempt");
      await send.waitFor();
    }
    async function switchTo(runtimeId) {
      const menu = page.locator("#harnessMenu");
      await page.locator("#harnessButton").click();
      await menu.locator(`[data-harness-select="${runtimeId}"]`).click();
      await menu.waitFor({ state: "hidden" });
      final = await (await context.request.get(conversation)).json();
      assert.equal(final.conversation.runtimeId, runtimeId);
    }
    await sendTurn(inputs[0]);
    const firstCodex = bindings().codex;
    assert.notEqual(firstCodex, "old-ephemeral");
    await sendTurn(inputs[1]);
    assert.equal(bindings().codex, firstCodex);
    await switchTo("grok-fixture");
    await sendTurn(inputs[2]);
    const firstGrok = bindings()["grok-fixture"];
    assert(firstGrok);
    await app.stop();
    await app.start();
    await page.goto(page.url());
    await switchTo("codex");
    await sendTurn(inputs[3]);
    await switchTo("grok-fixture");
    await sendTurn(inputs[4]);
    assert.deepEqual(bindings(), { codex: firstCodex, "grok-fixture": firstGrok });
    const codexTurns = app
      .calls()
      .filter(({ method, params }) => method === "turn/start" && params.threadId === firstCodex);
    assert.equal(codexTurns.length, 3);
    assert.match(codexTurns.at(-1).params.input[0].text, /Its release color is green\./);
    assert.match(codexTurns.at(-1).params.input[0].text, /Grok fixture reply/);
    assert.doesNotMatch(codexTurns.at(-1).params.input[0].text, /The fixture project is Orion\./);
    const catalog = await (await context.request.get(conversations)).json();
    assert.deepEqual(
      catalog.conversations.map((entry) => entry.id),
      [id],
    );
    const ordinary = await app.rpc("thread/list");
    const nativeIds = ordinary.result.data.map((entry) => entry.id);
    assert.equal(nativeIds.includes(firstCodex), false);
    assert.equal(sends, inputs.length);
    assert.deepEqual(
      final.messages.filter((message) => message.role === "user").map((message) => visibleHarnessText(message.text)),
      inputs,
    );
    assert.equal(final.conversation.id, id);
    const reopened = await context.newPage();
    reopened.on("pageerror", (error) => errors.push(error.message));
    await reopened.goto(page.url());
    for (const message of inputs) await reopened.locator("#conversation").getByText(message, { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await reopened.screenshot({ path: join(output, `${locale}-${width}.png`), scale: "css" });
    records.push({ width, locale, firstAttemptCompletions: sends, transcriptRestored: true, sameNativeSessions: true });
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, records }, null, 2));
console.log("Consecutive Codex sends and restored conversation history verified on PC and H5.");
