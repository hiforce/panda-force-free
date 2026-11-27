import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { smtpFixture } from "../support/smtp-fixture.js";

const proof = process.env.PANDA_FORCE_MEMORY_TEAM_PROOF || ".artifacts/project-memory-team";
await mkdir(proof, { recursive: true });
const mail = await smtpFixture();
let app;
try {
  app = await createAppFixture({
    freshAdministrator: true,
    applicationMemory: true,
    completedTurnNotifications: true,
    startupTimeoutMs: 60_000,
    extraEnvironment({ dir }) {
      const profiles = [false, true].map((pauseMemoryDispatch) => {
        const id = pauseMemoryDispatch ? "grok-paused" : "grok-local";
        const accountHome = join(dir, id);
        mkdirSync(accountHome, { recursive: true });
        writeFileSync(
          join(accountHome, "auth.json"),
          JSON.stringify({
            fixture: { access_token: "fixture-only", captureMemoryPrompt: true, pauseMemoryDispatch },
          }),
        );
        return { id, name: id, accountHome, command: resolve("tests/support/grok-acp-fixture.mjs") };
      });
      return { PANDA_FORCE_HARNESS_PROFILES: JSON.stringify(profiles) };
    },
  });
  const password = "Fixture-memory-pass-123";
  const call = (actor, path, body, method = body === undefined ? "GET" : "POST") =>
    fetch(app.base + path, {
      method,
      headers: { ...(actor ? { cookie: actor } : {}), origin: app.base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookie = (response) =>
    response.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
  const setup = await call("", "/api/auth/setup", { username: "root-fixture", password });
  assert(setup.ok, await setup.clone().text());
  const admin = cookie(setup);
  const api = async (owner, path, body, method) => {
    const response = await call(owner, path, body, method);
    assert(response.ok, path + " " + response.status + " " + (await response.clone().text()));
    return response.json();
  };
  const database = await api(admin, "/api/system/database");
  if (database.initialChoiceRequired) await api(admin, "/api/system/database/selection", { driver: "sqlite" });
  await api(admin, "/api/local-users/mail", { ...mail.config, revision: 0, publicUrl: app.base }, "PUT");
  const invite = async (name, role) => {
    const email = name + "@example.com";
    const count = mail.messages.length;
    await api(admin, "/api/local-users", { email, role, operationId: crypto.randomUUID() });
    const message = await waitFor(() => mail.messages[count]);
    const url = new URL(message.html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&"));
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    assert(token);
    await api("", "/api/local-users/invitation/accept", { token, password });
    const response = await call("", "/api/auth/login", { username: email, password });
    assert(response.ok);
    return cookie(response);
  };
  const alice = await invite("alice", "admin"),
    bob = await invite("bob", "admin"),
    readerAccount = await invite("reader", "member");
  const owners = new Map();
  for (const account of [alice, bob, readerAccount])
    owners.set(account, (await api(account, "/api/content-access")).owner);
  const grant = async (project, account, role) => {
    const { revision } = await api(admin, "/api/content-access/grants?project=" + project);
    return api(admin, "/api/content-access/grants", { project, owner: owners.get(account), role, revision }, "PUT");
  };
  const browserOptions = async (browser, cookie, width, locale) => {
    const context = await browser.newContext({
      locale,
      viewport: { width, height: 870 },
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    await context.addCookies(
      cookie.split("; ").map((item) => {
        const split = item.indexOf("=");
        return { name: item.slice(0, split), value: item.slice(split + 1), url: app.base };
      }),
    );
    await context.addInitScript((language) => {
      localStorage.setItem("panda-force-locale", language);
      localStorage.setItem("panda-force-theme", language === "en" || language === "zh-TW" ? "aurora" : "light");
    }, locale);
    return context;
  };
  const sessionRoot = "/api/personal/harness/conversations";
  const nativeHomes = join(app.dir, "panda-state", "harness", "native");
  const capturedAcpPrompt = async (question) => {
    for (const home of await readdir(nativeHomes)) {
      const prompt = await readFile(join(nativeHomes, home, "memory-prompt.json"), "utf8")
        .then(JSON.parse)
        .catch(() => []);
      if (prompt.some((part) => part.type === "text" && part.text.endsWith(question))) return JSON.stringify(prompt);
    }
    throw Error("The isolated ACP transport did not dispatch the request");
  };
  const completeTurn = async (who, id, text) => {
    const path = sessionRoot + "/" + id;
    const started = await api(who, path + "/runs", { requestId: crypto.randomUUID(), text });
    await waitFor(async () => (await api(who, path)).run?.status === "complete", 25000).catch(async (error) => {
      console.error("Team memory turn status", (await api(who, path)).run?.status);
      throw error;
    });
    return started.runId;
  };
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const code = "team-memory-" + locale.toLowerCase();
    const catalog = await api(admin, "/api/projects");
    const project = (
      await api(admin, "/api/projects", {
        code,
        name: "Atlas Web",
        revision: catalog.revision,
        operationId: crypto.randomUUID(),
      })
    ).projects.find((entry) => entry.code === code);
    assert(project);
    const root = "/api/projects/" + project.id + "/";
    const route = "/project?" + new URLSearchParams({ id: project.id, tab: "memory", memoryView: "records" });
    await grant(project.id, alice, "contributor");
    const hidden = await call(bob, root + "memory-team");
    assert.equal(hidden.status, 404);
    await grant(project.id, bob, "contributor");
    await api(
      alice,
      root + "memory-policy",
      {
        revision: 0,
        write: true,
        recall: false,
        model: { enabled: true, selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" } },
      },
      "PATCH",
    );
    await api(bob, root + "memory-policy", { revision: 0, write: false, recall: true }, "PATCH");
    const source = (await api(alice, sessionRoot, { runtimeId: "codex", projectId: project.id })).conversation;
    const recipient = (await api(bob, sessionRoot, { runtimeId: "codex", projectId: project.id })).conversation;
    const createGrok = async (options = {}) =>
      (await api(bob, sessionRoot, { projectId: project.id, runtimeId: "grok-local", ...options })).conversation;
    const grok = locale === "en" ? await createGrok() : null;
    const privateGrok = grok ? await createGrok({ memoryPrivate: true }) : null;
    const pending = grok ? await createGrok({ runtimeId: "grok-paused" }) : null;
    const privatePart = "Private discussion code aquamarine-939";
    await completeTurn(alice, source.id, privatePart);
    await completeTurn(alice, source.id, "Project convention [release]: cache retention = 14 days");
    await waitFor(async () => (await api(alice, root + "memory")).entries.length === 1);
    assert.deepEqual((await api(bob, root + "memory-team")).entries, []);
    assert.deepEqual((await api(bob, root + "memory")).entries, []);
    const [privateEntry] = (await api(alice, root + "memory")).entries;
    const original = privateEntry.sources[0];
    assert.equal(
      (
        await call(
          bob,
          root +
            "memory-source?" +
            new URLSearchParams({
              conversation: source.id,
              message: original.messageId,
            }),
        )
      ).status,
      404,
    );
    const browser = await engine.launch();
    let authorPage;
    try {
      const author = await browserOptions(browser, alice, width, locale);
      authorPage = await author.newPage();
      await authorPage.goto(app.base + route);
      const publish = authorPage.locator("[data-memory-team-publish]");
      await publish.waitFor();
      const label = await publish.getAttribute("aria-label");
      assert(label);
      if (width < 600) {
        const sizing = await publish.boundingBox();
        assert(sizing.width >= 44 && sizing.height >= 44);
        assert.equal(await publish.locator(".memory-team-action-label").isVisible(), false);
        assert(await publish.locator(".icon-slot").isVisible());
      }
      await publish.click();
      const confirmation = authorPage.getByRole("alertdialog");
      await confirmation.getByText(/\b14 days\b/).waitFor();
      assert.equal(await confirmation.getByText(privatePart).count(), 0);
      await authorPage.screenshot({ path: join(proof, "sharing-preview-" + locale + ".png") });
      await authorPage.keyboard.press("Escape");
      await confirmation.waitFor({ state: "hidden" });
      assert.deepEqual((await api(bob, root + "memory-team")).entries, []);
      assert(await publish.evaluate((button) => document.activeElement === button));
      await publish.click();
      await confirmation.getByText(/\b14 days\b/).waitFor();
      await confirmation.locator("button.primary").click();
      await waitFor(async () => (await api(bob, root + "memory-team")).entries.length === 1);

      await grant(project.id, bob, "reader");
      const team = await api(bob, root + "memory-team");
      assert.deepEqual(team.publications, []);
      assert.equal(team.canPublish, false);
      assert.equal(team.entries[0].value, "14 days");
      const serialized = JSON.stringify(team);
      assert(!serialized.includes(privatePart));
      assert(!serialized.includes(source.id));
      assert(!serialized.includes(original.messageId));
      const denied = await call(bob, root + "memory-team/" + privateEntry.id, { action: "preview" });
      assert.equal(denied.status, 404);
      const member = await browserOptions(browser, bob, width, locale);
      const memberPage = await member.newPage();
      await memberPage.goto(app.base + route);
      await memberPage.locator("[data-memory-team] [data-team-entry]").getByText("14 days").waitFor();
      await memberPage.locator(".memory-personal-heading").waitFor();
      assert.equal(await memberPage.locator("[data-memory-team] a[href*='memoryMessage']").count(), 0);
      assert(await memberPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await memberPage.screenshot({ path: join(proof, "sharing-recipient-" + locale + ".png") });
      if (locale === "en") {
        await grant(project.id, readerAccount, "reader");
        const localReader = await browserOptions(browser, readerAccount, width, locale);
        const readPage = await localReader.newPage();
        await readPage.goto(app.base + route);
        await readPage.locator("[data-memory-team] [data-team-entry]").getByText("14 days").waitFor();
        assert.equal(await readPage.locator("[data-memory-policy]").count(), 0);
        assert.equal((await call(readerAccount, root + "memory")).status, 403);
        assert.equal(
          (await call(readerAccount, root + "memory-team/" + privateEntry.id, { action: "preview" })).status,
          403,
        );
        assert.equal(
          (await call(readerAccount, root + "memory-team/" + privateEntry.id, { action: "withdraw", revision: 1 }))
            .status,
          404,
        );
        const crossOrigin = await fetch(app.base + root + "memory-team/" + privateEntry.id, {
          method: "POST",
          headers: { cookie: alice, origin: "https://invalid.example", "content-type": "application/json" },
          body: JSON.stringify({ action: "withdraw", revision: 1 }),
        });
        assert([401, 403].includes(crossOrigin.status));
        assert.equal((await api(bob, root + "memory-team")).entries[0].value, "14 days");
        assert.equal((await call(readerAccount, sessionRoot, { projectId: project.id })).status, 404);
      }
      const question = "How long is the release cache retention?";
      await completeTurn(bob, recipient.id, question);
      const recipientPath = sessionRoot + "/" + recipient.id;
      const details = await api(bob, recipientPath + "/memory");
      assert(
        details.recalls.some(({ references }) =>
          references.some((ref) => ref.team && ref.id === team.entries[0].id && ref.sources.length === 0),
        ),
      );
      const priorPrompt = app
        .calls()
        .filter((call) => call.method === "turn/start")
        .at(-1)?.params;
      assert(priorPrompt && JSON.stringify(priorPrompt).includes("14 days"));
      assert(!JSON.stringify(priorPrompt).includes(privatePart));
      if (grok && privateGrok && pending) {
        const teamId = team.entries[0].id;
        const grokPath = sessionRoot + "/" + grok.id;
        const askGrok = async (conversation, stage) => {
          const query = question + " [" + stage + "]";
          const runId = await completeTurn(bob, conversation.id, query);
          return { runId, prompt: await capturedAcpPrompt(query) };
        };
        const assertWithheld = (prompt) => {
          assert(!prompt.includes("14 days"));
          assert(!prompt.includes(teamId));
        };
        const eligible = await askGrok(grok, "shared");
        assert(eligible.prompt.includes("14 days"));
        assert(eligible.prompt.includes(teamId));
        assert(!eligible.prompt.includes(privatePart));
        assert(!eligible.prompt.includes(original.messageId));
        const grokReceipts = async () => (await api(bob, grokPath + "/memory")).recalls;
        assert(
          (await grokReceipts()).some(
            ({ runId, status, references }) =>
              runId === eligible.runId &&
              status === "sent" &&
              references.some((ref) => ref.team && ref.id === teamId && ref.sources.length === 0),
          ),
        );

        const changePaused = async (paused) => {
          const policyPath = grokPath + "/memory-policy";
          const {
            source: { revision },
          } = await api(bob, policyPath);
          await api(bob, policyPath, { revision, paused }, "PATCH");
          assert.equal((await api(bob, policyPath)).source.paused, paused);
        };
        await changePaused(true);
        const paused = await askGrok(grok, "paused");
        assertWithheld(paused.prompt);
        assert(!(await grokReceipts()).some(({ runId }) => runId === paused.runId));
        await changePaused(false);
        assert((await askGrok(grok, "resumed")).prompt.includes(teamId));
        const privateRecall = await askGrok(privateGrok, "private");
        assert(privateRecall.prompt.includes("14 days"));
        assert(privateRecall.prompt.includes(teamId));
        assert(!privateRecall.prompt.includes(privatePart));
        assert.equal((await call(bob, sessionRoot + "/" + privateGrok.id + "/memory")).status, 404);
        const unlinkedGrok = await createGrok({ projectId: null });
        assert(!unlinkedGrok.projectId);
        assertWithheld((await askGrok(unlinkedGrok, "unlinked")).prompt);

        const pendingPath = sessionRoot + "/" + pending.id;
        const dispatched = await api(bob, pendingPath + "/runs", {
          requestId: crypto.randomUUID(),
          text: question + " [withdrawal-race]",
          effort: "low",
        });
        assert(dispatched.runId);
        const pausedHome = await waitFor(async () => {
          for (const home of await readdir(nativeHomes)) {
            if (await Bun.file(join(nativeHomes, home, "memory-dispatch-paused")).exists())
              return join(nativeHomes, home);
          }
        });
        const pendingReceipts = async () => (await api(bob, pendingPath + "/memory")).recalls;
        try {
          assert(
            (await pendingReceipts()).some(
              ({ runId, status, references }) =>
                runId === dispatched.runId && status === "possible" && references.some((ref) => ref.id === teamId),
            ),
          );
          const sourcePath = sessionRoot + "/" + source.id;
          const impact = await api(alice, sourcePath + "/memory-removal-impact");
          await api(
            alice,
            sourcePath + "/memory-policy",
            { revision: 0, write: null, recall: null, revoke: true, impactToken: impact.token },
            "PATCH",
          );
          assert((await pendingReceipts()).every(({ references }) => !references.some((ref) => ref.id === teamId)));
        } finally {
          await writeFile(join(pausedHome, "memory-dispatch-release"), "");
        }
        await waitFor(async () => !(await api(bob, pendingPath)).conversation.activeRunId);
        assert(!(await Bun.file(join(pausedHome, "memory-prompt.json")).exists()));
        assertWithheld((await askGrok(privateGrok, "private-after-withdrawal")).prompt);
      } else {
        const own = authorPage.locator("[data-memory-team-own]");
        await own.locator("summary").click();
        await own.locator("[data-memory-team-withdraw]").click();
      }
      await waitFor(async () => (await api(bob, root + "memory-team")).entries.length === 0);
      assert(
        (await api(bob, recipientPath + "/memory")).recalls.every(({ references }) =>
          references.every((ref) => !ref.team),
        ),
      );
      await completeTurn(bob, recipient.id, question);
      const nextPrompt = app
        .calls()
        .filter((call) => call.method === "turn/start")
        .at(-1)?.params;
      assert(nextPrompt && priorPrompt.threadId !== nextPrompt.threadId);
      assert(!JSON.stringify(nextPrompt).includes("14 days"));
      await memberPage.reload();
      await memberPage.locator("[data-memory-team] [data-memory-team-results] p").waitFor();
      assert.equal(await memberPage.locator("[data-memory-team] [data-team-entry]").count(), 0);
    } catch (error) {
      if (authorPage)
        await authorPage.screenshot({ path: join(proof, "sharing-error-" + locale + ".png") }).catch(() => {});
      throw error;
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Team memory publishes approved conventions across local accounts and native harnesses, and fences revoked evidence before dispatch.",
  );
} finally {
  await app?.dispose();
  await mail.close();
}
